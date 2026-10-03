import { Worker, type Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import {
  creditSessionsRepository,
  meetingPresenceRepository,
  meetingsRepository,
  SettlementRefusedError,
  type CreditSession,
} from '@balo/db';
import { CASE_JOIN_WINDOW_MINUTES } from '@balo/shared/engagements';
import {
  MAX_SESSION_MINUTES,
  PENDING_STALE_CANCEL_MINUTES,
  WRAPPED_IDLE_END_MINUTES,
} from '@balo/shared/pricing';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import {
  driveSession,
  endSessionAsSystem,
  finalizeBilling,
  reconcileStuckSettlement,
  settleSessionFromPresence,
} from '../services/credit-session/index.js';
import { isReleasedSettlementCode } from '../services/credit-session/released-settlement-codes.js';
import { startBillingIfDue } from '../services/credit-session/start-billing.js';
import {
  SESSIONLESS_BACKSTOP_BATCH_LIMIT,
  SESSIONLESS_BACKSTOP_GRACE_MINUTES,
  SESSIONLESS_BACKSTOP_RETRY_HOURS,
  SESSIONLESS_BACKSTOP_WINDOW_HOURS,
  backstopWindowClosing,
  exhaustSessionlessCaseMeeting,
  settleSessionlessCaseMeeting,
} from '../services/credit-session/settle-sessionless-case-meeting.js';

/**
 * BAL-378 (ADR-1040 Lane 2) — the per-minute credit-session reaper. ONE repeatable BullMQ job
 * (concurrency 1, under the wallet advisory lock inside each repo method) doing the passes below
 * each tick, each row isolated in its own try/catch so one failure never aborts the batch:
 *
 *  0. BILLING-START (BAL-474, Rule A) — runs FIRST: Case meetings that are `in_progress` with an expert AND a
 *     client-side participant present and whose scheduled start has passed, but whose meter is not running
 *     (`listCaseMeetingsDueToStartBilling`) → `startBillingIfDue` opens the session if none exists and connects
 *     it at `max(start, co-presence)`, so the METER pass below draws its first ticks in the same run.
 *  0b. BEYOND-WINDOW (BAL-474, D11.2) — a `pending` presence session on a still-`scheduled` meeting that now
 *     starts beyond the join window (a reschedule's best-effort release failed) → cancel (releases the hold).
 *  1. METER — `findMeterable()` (active/grace) → `driveSession` posts the missing ticks + drives
 *     the grace/ceiling state machine + publishes transition notices. A well-funded but
 *     abandoned session is force-ended once it passes `MAX_SESSION_MINUTES`.
 *  2. WRAPPED-IDLE — sessions paused ≥ `WRAPPED_IDLE_END_MINUTES` → `endSession` (single
 *     settlement).
 *  3. STALE-PENDING — opened-but-never-connected ≥ `PENDING_STALE_CANCEL_MINUTES` → cancel
 *     (releases the hold).
 *  4. STUCK-SETTLING — `settlementStatus='processing'` past the reconcile cutoff → re-invoke the
 *     session-keyed charge (Stripe returns the same PI — no double-charge).
 *  5. PAYOUT-RECONCILE (BAL-399) — sessions finalized but with NO payout obligation booked (a
 *     crash or a swallowed `finalizeBilling.record()` throw between the `end()` commit and the
 *     payout booking) → replay `finalizeBilling` DIRECTLY (books the obligation + best-effort
 *     notices; does NOT settle/charge). Keys on the DB end-state, so it covers all four ending
 *     paths (route, wrapped-idle reaper, max-duration reaper, external) uniformly. Idempotent via
 *     the payout `created` guard, so it is race-safe against a concurrent legitimate finalize.
 *  5b. SESSIONLESS-MEETING BACKSTOP (BAL-474, ADR-1040 Amendment 7 §D) — ended Case meetings with NO
 *     session at all (`findSessionlessEndedCaseMeetings`): a client no-show, a guest-only call, an
 *     admission whose open was refused or threw. `settleSessionlessCaseMeeting` opens and settles
 *     each on behalf of the booker (or marks it `not_billable`); a still-sessionless meeting is
 *     exhausted — a marker plus ONE alarm — on the first attempt past 25h. Pass 6 below can only
 *     retry sessions that already exist; this is the pass for the ones that do not.
 *  6. PRESENCE-SETTLEMENT DURABILITY BACKSTOP (BAL-412, plan §4.3) — `duration_source='presence'`
 *     sessions whose MEETING has ended but which never settled (`findPresenceSettlementCandidates`). NEEDED
 *     because both terminal paths (`end-meeting.ts`, `meeting-lifecycle-sweep.ts`) call
 *     `settleSessionlessCaseMeeting` BEST-EFFORT and NON-FATAL, so a fault there strands a session
 *     `findFinalizedMissingPayout` (pass 5) cannot see — that finder keys on
 *     `billing_finalized_at IS NOT NULL`, the exact opposite half of this space. BAL-466 wires
 *     `duration_source='presence'` at admission (`joinMeetingAsMember`), so this pass is now
 *     reachable for a `case` meeting whose client was admitted. A settlement the repository refuses
 *     PERMANENTLY (`SettlementRefusedError`) gets an `audit_events` exhaustion marker, which
 *     the candidate finder excludes, so a row that can never settle cannot fill the batch and starve
 *     newer ones; every other error stays a log-and-retry. The alert read (`findPresenceUnsettled`)
 *     still sees marked rows.
 *  7. SETTLED-WITHOUT-CREDIT ALARM — `settlement_status='settled'` with NO `overdraft_settlement`
 *     ledger row (`findSettledMissingLedgerCredit`). ALARM ONLY: it writes nothing, because the
 *     repair belongs where the evidence is about to be erased (`markSettledFromReconcile`, which
 *     now verifies the credit and applies it before marking) and not in a sweep that would have
 *     to re-derive which PaymentIntent to trust. Post-fix this pass returns 0 forever; it exists
 *     to surface rows ALREADY corrupted in production and to fail loudly if anyone reintroduces a
 *     settled-without-credit write.
 *
 * Metering is deterministic + idempotent (tickSeq minute-index ledger key), so a re-meter that
 * crosses nothing publishes nothing. All money/lock logic lives in `@balo/db` — this stays thin.
 *
 * ⚠ BAL-474 (V4-F4) — EVERY PASS IS ISOLATED IN ITS OWN TRY/CATCH. Five passes' finders sit outside
 * any per-row try, so a persistent fault in ANY earlier pass used to abort the whole tick before a
 * later pass ran — including the sessionless-meeting backstop, whose whole point is to be the net
 * under a broken sibling. A broken pass now stays LOUD (an `error` log with the pass name plus
 * Sentry) and counts 0, but can no longer starve the passes behind it.
 */
export const CREDIT_SESSION_METER_SWEEP_QUEUE = 'credit-session-meter-sweep';
export const CREDIT_SESSION_METER_SWEEP_CRON = '* * * * *'; // every minute

const MS_PER_MINUTE = 60_000;
/** A settlement stuck in `processing` past this many minutes is reconciled (avoids racing the webhook). */
const STUCK_SETTLEMENT_MINUTES = 10;
/**
 * BAL-399: only reconcile a missing payout once its `billing_finalized_at` is this many minutes old
 * — a small grace (consistent with the local `STUCK_SETTLEMENT_MINUTES` posture) so we NEVER race
 * the µs-window between the `end()` commit and the `finalizeBilling.record()` commit of a
 * legitimate in-flight finalize.
 */
const PAYOUT_RECONCILE_GRACE_MINUTES = 5;
/**
 * BAL-412 (plan §4.3) — how far behind `now` a meeting's `ended_at` must be before the presence
 * durability backstop picks up its unsettled session. Mirrors `PAYOUT_RECONCILE_GRACE_MINUTES`'s
 * posture: small enough to recover quickly, large enough to never race the µs-window between a
 * terminal path's `endMeeting` commit and its own best-effort `settleSessionlessCaseMeeting` call.
 */
const PRESENCE_SETTLEMENT_GRACE_MINUTES = 2;
/** ⚠ THE CALLER MUST WARN WHEN THIS FILLS — the no-silent-caps rule. It does, below. */
const PRESENCE_SETTLEMENT_BATCH_LIMIT = 100;
/**
 * BAL-410 — the cancelled-meeting hold backstop's bound. ⚠ SAME NO-SILENT-CAPS RULE, and it
 * matters MORE here than for presence: a burst of cancellations during a DB blip is precisely
 * the scenario this backstop exists for, and it is precisely the scenario that queues >100 rows.
 * A silent cap would read as "swept everything" on a tick that stranded the rest.
 */
const CANCELLED_MEETING_BATCH_LIMIT = 100;
/**
 * Pass 7 — how far behind `now` a session's `settled_at` must be before "settled with no ledger
 * credit" counts as a corruption rather than a race. 60 minutes is deliberately generous against
 * the 10-minute `STUCK_SETTLEMENT_MINUTES` cutoff: the credit is applied in the SAME transaction
 * as the mark on both writers, so any gap at all is already anomalous — the hour exists purely so
 * a wildly-delayed webhook or a long `retrieveSettlement` retry can never page anyone.
 */
const SETTLED_MISSING_CREDIT_MINUTES = 60;
/** ⚠ SAME NO-SILENT-CAPS RULE as the two batch-bounded passes above. The caller warns; it does. */
const SETTLED_MISSING_CREDIT_BATCH_LIMIT = 100;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

const logger = createLogger('credit-session-meter-sweep');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * BAL-474 (V4-F4, D8.8) — run ONE pass inside its own try/catch. A throw is logged at `error` with
 * the pass name AND captured in Sentry, and the pass counts 0 — the tick continues to the next pass.
 * A broken pass is loud; it just cannot take the passes behind it down with it.
 */
async function runPassIsolated(
  passName: string,
  pass: () => Promise<number>,
  log: (message: string) => void
): Promise<number> {
  try {
    return await pass();
  } catch (error) {
    const message = errorMessage(error);
    log(`meter sweep pass ${passName} failed: ${message}`);
    logger.error(
      { pass: passName, error: message, stack: error instanceof Error ? error.stack : undefined },
      'Meter sweep pass failed — the tick continues with the next pass'
    );
    Sentry.captureException(error, { extra: { pass: passName } });
    return 0;
  }
}

/** Batch bound for the billing-start pass; the pass logs `warn` when the batch FILLS. */
const BILLING_START_BATCH_LIMIT = 100;
/** Batch bound for the beyond-window release pass. */
const BEYOND_WINDOW_BATCH_LIMIT = 100;

/**
 * Pass 0 (BAL-474, Rule A, D13) — THE BILLING-START PASS. It catches what no webhook fires for: a
 * co-presence that SPANS the scheduled start (nothing happens at T), a failed or wallet-busy open, a D5.9
 * guard that clears later, and a session a reschedule release cancelled. It is its OWN finder, so the
 * lifecycle sweep's 200-row window can never starve it, and it runs BEFORE the meter pass so a session it
 * connects is metered in the same run. `startBillingIfDue` never throws; a per-row failure is still
 * isolated. Returns how many meters it STARTED.
 */
async function runBillingStartPass(now: Date, log: (message: string) => void): Promise<number> {
  const due = await meetingsRepository.listCaseMeetingsDueToStartBilling({
    now,
    limit: BILLING_START_BATCH_LIMIT,
  });
  if (due.length === BILLING_START_BATCH_LIMIT) {
    // ⚠ NO SILENT CAPS — a full batch means due meetings were DROPPED from this tick.
    logger.warn(
      { limit: BILLING_START_BATCH_LIMIT, oldestMeetingId: due[0]?.meetingId },
      'Billing-start batch FILLED — meetings were left for the next tick'
    );
  }
  let started = 0;
  for (const { meetingId } of due) {
    try {
      const meeting = await meetingsRepository.findById(meetingId);
      if (meeting === undefined) {
        continue;
      }
      const openRows = await meetingPresenceRepository.listOpen(meetingId);
      const outcome = await startBillingIfDue({ meeting, openRows, now });
      if (outcome.kind === 'started') {
        started += 1;
      }
    } catch (error) {
      const message = errorMessage(error);
      log(`billing-start failed for meeting ${meetingId}: ${message}`);
      logger.error(
        {
          meetingId,
          error: message,
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Billing-start pass failed for a meeting'
      );
    }
  }
  return started;
}

/**
 * Pass 0b (BAL-474, D11.2, security N2) — release a `pending` presence session whose meeting is still
 * `scheduled` but now starts BEYOND the join window. The reschedule itself releases it
 * (`rescheduleMeeting`); this is the second chance if that best-effort release failed. Returns how many
 * holds it freed. `cancel` releases the hold under the wallet lock it takes itself and is idempotent.
 */
async function runBeyondWindowPass(now: Date, log: (message: string) => void): Promise<number> {
  const sessions = await creditSessionsRepository.findPendingBeyondJoinWindow({
    now,
    windowMs: CASE_JOIN_WINDOW_MINUTES * MS_PER_MINUTE,
    limit: BEYOND_WINDOW_BATCH_LIMIT,
  });
  let released = 0;
  for (const session of sessions) {
    try {
      await creditSessionsRepository.cancel(session.id, { memberId: session.initiatingMemberId });
      released += 1;
    } catch (error) {
      const message = errorMessage(error);
      log(`beyond-window release failed for session ${session.id}: ${message}`);
      logger.error(
        {
          sessionId: session.id,
          meetingId: session.meetingId,
          error: message,
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Beyond-window pending session could not be released'
      );
    }
  }
  return released;
}

/** Force-end a still-live session that has run past the safety cap. */
async function enforceMaxDuration(session: CreditSession, now: Date): Promise<void> {
  if ((session.status !== 'active' && session.status !== 'grace') || session.connectedAt === null) {
    return;
  }
  const elapsedMinutes = Math.floor(
    (now.getTime() - session.connectedAt.getTime()) / MS_PER_MINUTE
  );
  if (elapsedMinutes < MAX_SESSION_MINUTES) {
    return;
  }
  // BAL-412 (Q3, plan §4.3) — a `presence` session's terminal path is the meeting lifecycle
  // sweep's `idle_end` / `overrun_stop` rules (`meeting-lifecycle-sweep.ts`), NEVER this force-end:
  // finalizing it here would settle it behind the meeting's back, with no floor and no outcome
  // resolved. Skipped and left to those rules; settlement (`settleSessionlessCaseMeeting`) follows
  // from there, and this file's own pass 6 durability backstop covers a settlement that then fails.
  //
  // The skip is safe because presence draw is bounded twice: `meterSessionToNow` never posts a tick
  // past `MAX_SESSION_MINUTES`, and the lifecycle sweep ends the meeting at its `overrun_stop` hard ceiling.
  // Settlement bills `max(ruleMinutes <= 240, drawn <= 240)`; only legacy rows drawn before the
  // clamp can exceed that, and they settle in full. (An earlier revision credited
  // `effectiveCeilingMinor` with bounding settlement; it bounds only the live overdraft wrap.)
  if (session.durationSource === 'presence') {
    logger.warn(
      { sessionId: session.id, elapsedMinutes },
      'Presence session exceeded MAX_SESSION_MINUTES — skipping force-end; the meeting lifecycle sweep (its idle-end / overrun-stop rules) owns termination for this duration_source, not this reaper'
    );
    return;
  }
  logger.warn(
    { sessionId: session.id, elapsedMinutes },
    'Session exceeded MAX_SESSION_MINUTES — force-ending'
  );
  // System force-end — the reaper is the system, not an actor, so it bypasses the actor
  // authorization `endSession` applies (a departed initiating member must not strand the session).
  await endSessionAsSystem(session.id, { now });
}

/** Pass 1 — meter every active/grace session + enforce the max-duration cap. */
async function runMeterPass(now: Date, log: (message: string) => void): Promise<number> {
  let metered = 0;
  const sessions = await creditSessionsRepository.findMeterable();
  for (const session of sessions) {
    try {
      const result = await driveSession(session.id, now);
      metered += 1;
      await enforceMaxDuration(result.session, now);
    } catch (error) {
      const message = errorMessage(error);
      log(`meter failed for session ${session.id}: ${message}`);
      logger.error({ sessionId: session.id, error: message }, 'Session meter failed');
    }
  }
  return metered;
}

/** Pass 2 — auto-end warmly-paused sessions idle past the timeout (single settlement). */
async function runWrappedIdlePass(now: Date, log: (message: string) => void): Promise<number> {
  let ended = 0;
  const cutoff = new Date(now.getTime() - WRAPPED_IDLE_END_MINUTES * MS_PER_MINUTE);
  const sessions = await creditSessionsRepository.findWrappedIdle(cutoff);
  for (const session of sessions) {
    try {
      await endSessionAsSystem(session.id, { now });
      ended += 1;
    } catch (error) {
      const message = errorMessage(error);
      log(`wrapped-idle end failed for session ${session.id}: ${message}`);
      logger.error({ sessionId: session.id, error: message }, 'Wrapped-idle auto-end failed');
    }
  }
  return ended;
}

/** Pass 3 — auto-cancel opened-but-never-connected sessions (release the hold). */
async function runStalePendingPass(now: Date, log: (message: string) => void): Promise<number> {
  let cancelled = 0;
  const cutoff = new Date(now.getTime() - PENDING_STALE_CANCEL_MINUTES * MS_PER_MINUTE);
  const sessions = await creditSessionsRepository.findStalePending(cutoff);
  for (const session of sessions) {
    try {
      await creditSessionsRepository.cancel(session.id);
      cancelled += 1;
    } catch (error) {
      const message = errorMessage(error);
      log(`stale-pending cancel failed for session ${session.id}: ${message}`);
      logger.error({ sessionId: session.id, error: message }, 'Stale-pending auto-cancel failed');
    }
  }
  return cancelled;
}

/**
 * Pass 3b (BAL-410) — THE CANCELLED-MEETING HOLD BACKSTOP.
 *
 * ⚠⚠ WHY IT EXISTS, AND WHY IT IS NOT A WIDENING OF PASS 3. Cancelling a meeting is the ONE
 * state change that removes it from every reaper: `findStalePending` excludes
 * `duration_source='presence'` (deliberately — BAL-412 F4), `findPresenceUnsettled` requires
 * `meetings.status='ended'`, and the meeting-lifecycle sweep scans only the three non-terminal
 * statuses. So the in-request release in the cancel route (`meeting-availability.ts`'s
 * `releaseCreditHoldBestEffort`) has NO SECOND CHANCE, and one transient DB error there strands
 * the hold PERMANENTLY: the company's available balance is reduced forever AND `open()`'s
 * one-live-session-per-wallet gate locks that company out of every future Case session. This
 * pass is that second chance.
 *
 * ⚠ NO CUTOFF, AND NO `duration_source` FILTER — both deliberate, both explained on
 * `findPendingForCancelledMeetings`'s own docblock. A cancelled meeting is immediately final,
 * and on a cancelled meeting there is nothing to settle for ANY provenance, so `cancelled` is
 * the only correct terminal. Racing the in-request release is safe: `cancel` returns early on an
 * already-`cancelled` session.
 *
 * ⚠ `memberId: null` — the ADR-1030 SYSTEM-ACTOR EXEMPTION. The hold's `member_id` records WHO
 * resolved it; the sweep is nobody, and a fabricated actor would be worse than an unattributed
 * row. Matches pass 3, which passes no `memberId` at all.
 *
 * ⚠ BOUNDED AND LOUD ABOUT IT — `CANCELLED_MEETING_BATCH_LIMIT`, with the same "batch FILLED"
 * warn `runPresenceSettlementPass` uses. Never call the finder bare: its default limit would
 * cap the tick silently.
 *
 * Per-row try/catch so one bad row never stops the batch — the shape every pass here uses.
 */
async function runCancelledMeetingPass(log: (message: string) => void): Promise<number> {
  let released = 0;
  const sessions = await creditSessionsRepository.findPendingForCancelledMeetings(
    CANCELLED_MEETING_BATCH_LIMIT
  );
  if (sessions.length === CANCELLED_MEETING_BATCH_LIMIT) {
    // ⚠ NO SILENT CAPS — a full batch means stranded holds were DROPPED from this tick, and
    // every one of them is a company locked out of its next Case session until the next tick.
    const [oldest] = sessions;
    logger.warn(
      { limit: CANCELLED_MEETING_BATCH_LIMIT, oldestSessionId: oldest?.id },
      'Cancelled-meeting hold batch FILLED — stranded holds were dropped from this tick'
    );
  }
  for (const session of sessions) {
    try {
      await creditSessionsRepository.cancel(session.id, { memberId: null });
      released += 1;
    } catch (error) {
      const message = errorMessage(error);
      log(`cancelled-meeting hold release failed for session ${session.id}: ${message}`);
      logger.error(
        { sessionId: session.id, error: message },
        'Cancelled-meeting hold release backstop failed'
      );
    }
  }
  if (released > 0) {
    // ⚠ LOUD ON PURPOSE. The in-request release is meant to handle every one of these; a
    // non-zero count here means the cancel route's step 2 failed, which is the money leak this
    // backstop exists to catch. The RATE is the health signal.
    logger.warn(
      { released },
      'Cancelled-meeting hold backstop released holds the cancel route should already have released'
    );
  }
  return released;
}

/** Pass 4 — reconcile settlements stuck in `processing` (re-invoke the session-keyed charge). */
async function runStuckSettlingPass(now: Date, log: (message: string) => void): Promise<number> {
  let reconciled = 0;
  const cutoff = new Date(now.getTime() - STUCK_SETTLEMENT_MINUTES * MS_PER_MINUTE);
  const sessions = await creditSessionsRepository.findStuckSettling(cutoff);
  for (const session of sessions) {
    try {
      await reconcileStuckSettlement(session, { now });
      reconciled += 1;
    } catch (error) {
      const message = errorMessage(error);
      log(`stuck-settlement reconcile failed for session ${session.id}: ${message}`);
      logger.error({ sessionId: session.id, error: message }, 'Stuck-settlement reconcile failed');
    }
  }
  return reconciled;
}

/**
 * Pass 5 (BAL-399) — reconcile FINALIZED sessions that never got a payout obligation booked (a
 * crash or a swallowed `finalizeBilling.record()` throw). Replays `finalizeBilling` DIRECTLY —
 * NOT `finalizeExternalDuration` (its `billing_finalized_at` guard would block it) and NOT
 * `endSessionAsSystem` (would needlessly re-drive the meter / re-enter settlement). `finalizeBilling`
 * only books the payout + best-effort notices + analytics; it never settles/charges, so it is safe
 * for overdraft(`processing`) sessions too (expert-always-paid is independent of settlement).
 * Idempotent via the payout `created` guard.
 */
async function runFinalizedMissingPayoutPass(
  now: Date,
  log: (message: string) => void
): Promise<number> {
  let recovered = 0;
  const cutoff = new Date(now.getTime() - PAYOUT_RECONCILE_GRACE_MINUTES * MS_PER_MINUTE);
  const sessions = await creditSessionsRepository.findFinalizedMissingPayout(cutoff);
  for (const session of sessions) {
    try {
      await finalizeBilling(session, session.finalizationPath ?? 'live_capture', now);
      recovered += 1;
      logger.info(
        { sessionId: session.id, finalizationPath: session.finalizationPath },
        'Recovered stranded payout obligation (finalizeBilling replay)'
      );
    } catch (error) {
      const message = errorMessage(error);
      log(`payout reconcile failed for session ${session.id}: ${message}`);
      logger.error({ sessionId: session.id, error: message }, 'Payout reconcile failed');
    }
  }
  return recovered;
}

/**
 * Pass 5b (BAL-474, ADR-1040 Amendment 7 §D, D5.4, D5.5, D7.5) — THE SESSIONLESS-MEETING DURABILITY
 * BACKSTOP. Pass 6 can only retry sessions that already EXIST; this finds ended Case meetings that
 * have NONE — a client no-show whose terminal-path attempt threw or was deferred, a guest-only call, an
 * admission whose open was refused — and runs the same `settleSessionlessCaseMeeting` the terminal
 * paths run (`trigger: 'backstop'`). Idempotent: the finder's `NOT EXISTS`, the in-lock
 * one-session-per-meeting check and the single transaction make it race the inline attempt harmlessly.
 *
 * WINDOWS. The finder selects meetings that ended at least {@link SESSIONLESS_BACKSTOP_GRACE_MINUTES}
 * ago (the inline path had its go) and whose `scheduled_start` AND `ended_at` are inside
 * {@link SESSIONLESS_BACKSTOP_WINDOW_HOURS}. Retry EXHAUSTION is decided on the FIRST attempt past
 * {@link SESSIONLESS_BACKSTOP_RETRY_HOURS}, whenever that attempt runs — the window leaves 47 hours of
 * ticks in which it can land, so a redeploy, a slow tick or a database blip cannot age a row out
 * silently — OR on an attempt inside the finder's LAST hour ({@link backstopWindowClosing}): a meeting
 * that ended long after its scheduled start reaches the window's edge before it reaches the retry age. Exhaustion writes a marker (the row leaves the finder, so it happens exactly once) and
 * raises ONE alarm.
 *
 * ⚠⚠ A THROWN ATTEMPT IS EXHAUSTED ONLY IF IT BILLED NOTHING (V4-F3). The throw can come from the
 * post-commit TAIL after `openAndSettleFromPresence` committed (`finalizeAndSettle`, the settlement
 * stamp, the dunning claim). So before exhausting on a throw the pass re-reads
 * `findIdByMeetingId`: a session exists ⇒ the consultation IS billed — log `error` (+ Sentry), NO
 * marker, NO alert; the reconcile and payout passes own what is left. No session ⇒ exhausted.
 *
 * ⚠ BOUNDED AND LOUD ABOUT IT — `SESSIONLESS_BACKSTOP_BATCH_LIMIT`, with the same "batch FILLED" warn
 * the other backstops use. Per-row try/catch so one bad row never stops the batch.
 */
async function runSessionlessCaseMeetingPass(
  now: Date,
  log: (message: string) => void
): Promise<number> {
  let settled = 0;
  const candidates = await creditSessionsRepository.findSessionlessEndedCaseMeetings({
    endedBefore: new Date(now.getTime() - SESSIONLESS_BACKSTOP_GRACE_MINUTES * MS_PER_MINUTE),
    windowStart: new Date(now.getTime() - SESSIONLESS_BACKSTOP_WINDOW_HOURS * MS_PER_HOUR),
    limit: SESSIONLESS_BACKSTOP_BATCH_LIMIT,
  });
  if (candidates.length === SESSIONLESS_BACKSTOP_BATCH_LIMIT) {
    // ⚠ NO SILENT CAPS — a full batch means sessionless meetings were DROPPED from this tick.
    const [oldest] = candidates;
    logger.warn(
      { limit: SESSIONLESS_BACKSTOP_BATCH_LIMIT, oldestMeetingId: oldest?.meetingId },
      'Sessionless-meeting batch FILLED — meetings were dropped from this tick'
    );
  }
  const retryCutoffMs = now.getTime() - SESSIONLESS_BACKSTOP_RETRY_HOURS * MS_PER_HOUR;
  for (const candidate of candidates) {
    // Exhausted on the first attempt past the retry age, OR when the finder is about to drop the row
    // (a meeting that ended long after its scheduled start reaches the window's edge first — D10.2).
    const pastRetryWindow =
      candidate.endedAt.getTime() <= retryCutoffMs || backstopWindowClosing(candidate, now);
    try {
      const result = await settleSessionlessCaseMeeting({
        meetingId: candidate.meetingId,
        trigger: 'backstop',
        actorUserId: null,
        now,
      });
      if (result.kind === 'opened_and_settled') {
        settled += 1;
      } else if (result.kind === 'deferred' && pastRetryWindow) {
        await exhaustSessionlessCaseMeeting({
          meetingId: candidate.meetingId,
          reason: 'session_in_progress',
          trigger: 'backstop',
          outcome: result.outcome,
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      log(`sessionless-meeting backstop failed for meeting ${candidate.meetingId}: ${message}`);
      await handleSessionlessAttemptFailure(candidate.meetingId, error, pastRetryWindow);
    }
  }
  return settled;
}

/**
 * A backstop attempt THREW. If a session now exists the throw was in the post-commit tail after a
 * committed open-and-settle: the consultation is billed, so write NO marker and raise NO alert — just
 * log `error` + Sentry (V4-F3). Otherwise the row is exhausted when it is past the retry window and
 * left for the next tick when it is not. Never throws: it runs inside the per-row catch.
 */
async function handleSessionlessAttemptFailure(
  meetingId: string,
  error: unknown,
  pastRetryWindow: boolean
): Promise<void> {
  const fields = {
    meetingId,
    error: errorMessage(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  try {
    if ((await creditSessionsRepository.findIdByMeetingId(meetingId)) !== undefined) {
      logger.error(
        fields,
        'Sessionless meeting opened and settled; its post-commit tail failed — the reconcile and payout passes own the recovery'
      );
      Sentry.captureException(error, { extra: { meetingId, op: 'sessionless_backstop_tail' } });
      return;
    }
    logger.error(fields, 'Sessionless-meeting backstop attempt failed');
    if (pastRetryWindow) {
      await exhaustSessionlessCaseMeeting({ meetingId, reason: 'error', trigger: 'backstop' });
    }
  } catch (followUpError) {
    logger.error(
      {
        meetingId,
        error: errorMessage(followUpError),
        stack: followUpError instanceof Error ? followUpError.stack : undefined,
      },
      'Sessionless-meeting backstop could not record its failure — the next tick retries'
    );
  }
}

/**
 * Pass 6 — record that a session's settlement was permanently refused, removing it from the
 * backstop's candidate read. Never throws: a failed marker write is logged and the row is retried
 * on the next tick.
 */
async function exhaustPresenceSettlement(
  session: CreditSession,
  error: SettlementRefusedError
): Promise<void> {
  try {
    await creditSessionsRepository.markPresenceSettlementExhausted({
      sessionId: session.id,
      ...(session.meetingId === null ? {} : { meetingId: session.meetingId }),
      guard: error.guard,
      error: error.message,
    });
    logger.error(
      { sessionId: session.id, guard: error.guard, error: error.message },
      'Presence settlement permanently refused — marked exhausted and removed from pass 6'
    );
  } catch (markerError) {
    logger.error(
      { sessionId: session.id, guard: error.guard, error: errorMessage(markerError) },
      'Presence settlement refusal marker write failed — will retry on the next tick'
    );
  }
}

/**
 * Pass 6 (BAL-412, plan §4.3) — THE PRESENCE-SETTLEMENT DURABILITY BACKSTOP. Both terminal paths
 * (`end-meeting.ts`, `meeting-lifecycle-sweep.ts`) call `settleSessionlessCaseMeeting` BEST-EFFORT and
 * NON-FATAL, so a settlement fault there strands a session that pass 5 above CANNOT see —
 * `findFinalizedMissingPayout` keys on `billing_finalized_at IS NOT NULL`, the exact opposite
 * half of the space. Pass 6's read is `findPresenceSettlementCandidates`: a meeting that has ENDED
 * with a `duration_source='presence'` session that never settled, minus sessions already marked
 * permanently refused. `findPresenceUnsettled` is the unfiltered read kept for the admin alert.
 * After the loop, `countPresenceSettlementExhausted` drives an interim warn so marked sessions
 * never go silent while they await manual repair.
 *
 * `settleSessionFromPresence` is itself idempotent (the repository's row lock is the real
 * guard), so a row picked up here and settled by a racing terminal path in the same instant is a
 * harmless `already_settled` no-op.
 *
 * ⚠ BAL-466 wires it: `joinMeetingAsMember` opens a `duration_source='presence'` session when
 * the first CLIENT-side member is admitted to a `case` meeting, so the candidate read now
 * selects a real row once that meeting ends unsettled — see `credit-sessions.integration.test.ts`
 * for the end-to-end proof.
 */
async function runPresenceSettlementPass(
  now: Date,
  log: (message: string) => void
): Promise<number> {
  let settled = 0;
  const cutoff = new Date(now.getTime() - PRESENCE_SETTLEMENT_GRACE_MINUTES * MS_PER_MINUTE);
  const sessions = await creditSessionsRepository.findPresenceSettlementCandidates(
    cutoff,
    PRESENCE_SETTLEMENT_BATCH_LIMIT
  );
  if (sessions.length === PRESENCE_SETTLEMENT_BATCH_LIMIT) {
    // ⚠ NO SILENT CAPS — a full batch means unsettled sessions were DROPPED from this tick.
    const [oldest] = sessions;
    logger.warn(
      { limit: PRESENCE_SETTLEMENT_BATCH_LIMIT, oldestSessionId: oldest?.id },
      'Presence-unsettled batch FILLED — sessions were dropped from this tick'
    );
  }
  for (const session of sessions) {
    try {
      const outcome = await settleSessionFromPresence({
        sessionId: session.id,
        actorUserId: null,
        now,
      });
      if (outcome.ok) {
        settled += 1;
      } else if (isReleasedSettlementCode(outcome.code)) {
        // Terminal, not "declined": a session released with nothing owed (a no-show on a case closed before
        // the start, or a call attended only by guests the delivering expert invited).
        logger.info(
          { sessionId: session.id, code: outcome.code },
          'Session released with nothing owed — released by the presence-settlement backstop'
        );
      } else if (outcome.code !== 'already_settled') {
        // A racing terminal path settled it between the finder read and here → benign. Anything
        // else (`no_meeting` / `meeting_not_terminal` / `not_presence_sourced`) means the finder's
        // predicate and this service's preconditions disagree — worth a look, not a crash.
        logger.warn(
          { sessionId: session.id, code: outcome.code },
          'Presence settlement durability backstop declined'
        );
      }
    } catch (error) {
      if (error instanceof SettlementRefusedError) {
        await exhaustPresenceSettlement(session, error);
        continue;
      }
      const message = errorMessage(error);
      log(`presence settlement backstop failed for session ${session.id}: ${message}`);
      logger.error(
        { sessionId: session.id, error: message },
        'Presence settlement backstop failed'
      );
    }
  }
  await warnOnExhaustedPresenceSettlements(cutoff);
  return settled;
}

/** Interim signal for permanently refused sessions; never throws out of the sweep. */
async function warnOnExhaustedPresenceSettlements(cutoff: Date): Promise<void> {
  try {
    const exhaustedCount = await creditSessionsRepository.countPresenceSettlementExhausted(cutoff);
    if (exhaustedCount > 0) {
      logger.warn(
        { exhaustedCount },
        'Presence sessions refused settlement and are awaiting manual repair'
      );
    }
  } catch (error) {
    logger.error({ error: errorMessage(error) }, 'Counting exhausted presence settlements failed');
  }
}

/**
 * Pass 7 — THE SETTLED-WITHOUT-CREDIT ALARM. A session marked `settlement_status='settled'` with
 * no `overdraft_settlement` ledger row is money Stripe took, a receivable cleared, dunning
 * stopped, and NOTHING in the ledger to show for it — the client is even shown "settled", because
 * `settlement_status` is on the client allow-list.
 *
 * ⚠ ALARM ONLY — IT WRITES NOTHING, AND THAT IS DELIBERATE. The repair lives at the moment the
 * evidence is about to be erased (`markSettledFromReconcile` now verifies the credit and applies
 * it through the webhook pipeline before anything is marked or cleared), where a
 * proven-`succeeded` PaymentIntent is already in hand. A sweep firing an hour later would have to
 * re-derive which PI to trust from a row that has already been rewritten — repair from weaker
 * evidence than the path that caused the problem. So this pass reports and stops.
 *
 * ⚠ `log.error` PER ROW, ON PURPOSE — this is a Sentry/Axiom-visible money discrepancy needing a
 * human, not a warn to be buried. The recovery for a row reported here is a Stripe Dashboard
 * **Resend** of the original `payment_intent.succeeded`: the lost commit persisted no
 * `stripe_webhook_events` marker, so the webhook's replay short-circuit does not swallow it.
 *
 * ⚠ NO PER-ROW TRY/CATCH, unlike every other pass — there is no per-row work that CAN fail: the
 * body is a `log.error` per row. A throw from the FINDER itself is caught by the tick's per-pass
 * isolation ({@link runPassIsolated}), which logs it, captures it in Sentry and counts 0; the
 * per-minute repeat retries it.
 */
async function runSettledMissingCreditPass(
  now: Date,
  log: (message: string) => void
): Promise<number> {
  const cutoff = new Date(now.getTime() - SETTLED_MISSING_CREDIT_MINUTES * MS_PER_MINUTE);
  const sessions = await creditSessionsRepository.findSettledMissingLedgerCredit(
    cutoff,
    SETTLED_MISSING_CREDIT_BATCH_LIMIT
  );
  if (sessions.length === SETTLED_MISSING_CREDIT_BATCH_LIMIT) {
    // ⚠ NO SILENT CAPS — a full batch means corrupted sessions were DROPPED from this tick's
    // report, and the count below would read as the whole of the damage.
    const [oldest] = sessions;
    logger.warn(
      { limit: SETTLED_MISSING_CREDIT_BATCH_LIMIT, oldestSessionId: oldest?.id },
      'Settled-without-credit batch FILLED — further corrupted sessions were dropped from this tick'
    );
  }
  if (sessions.length > 0) {
    // ONE error per TICK, not per row. The sweep runs every minute forever, and each corrupted
    // row needs a HUMAN (a Stripe Dashboard resend) — per-row errors turned one stuck row into
    // 1,440 identical error records a day (Pino → Axiom; Sentry has no log integration here)
    // while adding nothing a responder can act on. The per-session identifiers all ride in the
    // single record's `sessions` array.
    log(`settled with NO overdraft_settlement ledger credit: ${sessions.length} session(s)`);
    logger.error(
      {
        count: sessions.length,
        sessions: sessions.map((session) => ({
          sessionId: session.id,
          walletId: session.walletId,
          companyId: session.companyId,
          settledAt: session.settledAt,
          overdraftSettledMinor: session.overdraftSettledMinor,
          stripePaymentIntentId: session.stripePaymentIntentId,
        })),
      },
      'Sessions are marked settled with NO overdraft_settlement ledger credit — money charged, wallet never credited, receivable cleared; recover by resending each payment_intent.succeeded from the Stripe Dashboard'
    );
  }
  return sessions.length;
}

/** The sweep body (exported for unit testing without a Redis-backed Worker). */
export async function runSessionMeterSweep(
  now: Date,
  log: (message: string) => void = () => {}
): Promise<{
  metered: number;
  ended: number;
  cancelled: number;
  /** BAL-410 — holds freed by the cancelled-meeting backstop. Non-zero ⇒ the cancel route's
   *  in-request release failed; see `runCancelledMeetingPass`. */
  cancelledMeetingHolds: number;
  reconciled: number;
  recovered: number;
  /** BAL-474 — sessionless ended Case meetings this tick opened AND settled. Non-zero ⇒ a terminal
   *  path's inline attempt did not complete; see `runSessionlessCaseMeetingPass`. */
  sessionlessMeetingsSettled: number;
  /** BAL-474 (Rule A) — meters this tick STARTED at the billing-start pass. */
  billingStarted: number;
  /** BAL-474 (D11.2) — pending sessions released because their meeting moved beyond the join window. */
  beyondWindowReleased: number;
  presenceSettled: number;
  /** Pass 7 — sessions marked `settled` with NO `overdraft_settlement` ledger credit. Non-zero ⇒
   *  a money discrepancy needing a human; see `runSettledMissingCreditPass`. Expected 0 forever. */
  settledMissingCredit: number;
}> {
  // ⚠ BAL-474 (V4-F4) — every pass in its own try/catch (`runPassIsolated`): a broken pass is loud and
  // counts 0, and cannot starve the ones behind it.
  // BAL-474 (Rule A) — billing starts FIRST, so a meter it connects draws its first ticks this run; then
  // the beyond-window release (a moved call's pending session must not sit on the wallet).
  const billingStarted = await runPassIsolated(
    'billing_start',
    () => runBillingStartPass(now, log),
    log
  );
  const beyondWindowReleased = await runPassIsolated(
    'beyond_window',
    () => runBeyondWindowPass(now, log),
    log
  );
  const metered = await runPassIsolated('meter', () => runMeterPass(now, log), log);
  const ended = await runPassIsolated('wrapped_idle', () => runWrappedIdlePass(now, log), log);
  const cancelled = await runPassIsolated(
    'stale_pending',
    () => runStalePendingPass(now, log),
    log
  );
  // BAL-410 — runs beside the stale-pending pass, never inside it: the two select DISJOINT rows
  // for opposite reasons. See `runCancelledMeetingPass`.
  const cancelledMeetingHolds = await runPassIsolated(
    'cancelled_meeting',
    () => runCancelledMeetingPass(log),
    log
  );
  const reconciled = await runPassIsolated(
    'stuck_settling',
    () => runStuckSettlingPass(now, log),
    log
  );
  const recovered = await runPassIsolated(
    'finalized_missing_payout',
    () => runFinalizedMissingPayoutPass(now, log),
    log
  );
  // BAL-474 — the sessionless-meeting backstop, before the presence-unsettled pass: a session this
  // pass opens-and-settles is finalized in the same call, so pass 6 never sees it half-done.
  const sessionlessMeetingsSettled = await runPassIsolated(
    'sessionless_case_meeting',
    () => runSessionlessCaseMeetingPass(now, log),
    log
  );
  const presenceSettled = await runPassIsolated(
    'presence_settlement',
    () => runPresenceSettlementPass(now, log),
    log
  );
  // Runs LAST, after the reconcile pass that repairs this shape at its source — so a row this
  // tick's pass 4 has just healed is never also reported here as corrupt.
  const settledMissingCredit = await runPassIsolated(
    'settled_missing_credit',
    () => runSettledMissingCreditPass(now, log),
    log
  );
  logger.info(
    {
      billingStarted,
      beyondWindowReleased,
      metered,
      ended,
      cancelled,
      cancelledMeetingHolds,
      reconciled,
      recovered,
      sessionlessMeetingsSettled,
      presenceSettled,
      settledMissingCredit,
    },
    'Session meter sweep complete'
  );
  return {
    billingStarted,
    beyondWindowReleased,
    metered,
    ended,
    cancelled,
    cancelledMeetingHolds,
    reconciled,
    recovered,
    sessionlessMeetingsSettled,
    presenceSettled,
    settledMissingCredit,
  };
}

/** Start the credit-session meter sweep worker (concurrency 1 — serialised passes). */
export function startCreditSessionMeterSweepWorker(): Worker {
  return new Worker(
    CREDIT_SESSION_METER_SWEEP_QUEUE,
    async (job: Job) => {
      const {
        billingStarted,
        beyondWindowReleased,
        metered,
        ended,
        cancelled,
        reconciled,
        recovered,
        sessionlessMeetingsSettled,
        presenceSettled,
        settledMissingCredit,
      } = await runSessionMeterSweep(new Date(), (m) => job.log(m));
      job.log(
        `session meter sweep: ${billingStarted} billing-started, ${beyondWindowReleased} beyond-window-released, ${metered} metered, ${ended} ended, ${cancelled} cancelled, ${reconciled} reconciled, ${recovered} recovered, ${sessionlessMeetingsSettled} sessionless-settled, ${presenceSettled} presence-settled, ${settledMissingCredit} settled-without-credit`
      );
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable per-minute meter sweep. */
export async function registerCreditSessionMeterSweepCron(): Promise<void> {
  const queue = getQueue(CREDIT_SESSION_METER_SWEEP_QUEUE);
  await queue.add(
    'sweep',
    {},
    {
      repeat: { pattern: CREDIT_SESSION_METER_SWEEP_CRON },
      removeOnComplete: true,
    }
  );
}
