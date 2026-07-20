import { Worker, type Job } from 'bullmq';
import { creditSessionsRepository, type CreditSession } from '@balo/db';
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
} from '../services/credit-session/index.js';

/**
 * BAL-378 (ADR-1040 Lane 2) — the per-minute credit-session reaper. ONE repeatable BullMQ job
 * (concurrency 1, under the wallet advisory lock inside each repo method) doing four passes each
 * tick, each row isolated in its own try/catch so one failure never aborts the batch:
 *
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
 *
 * Metering is deterministic + idempotent (tickSeq minute-index ledger key), so a re-meter that
 * crosses nothing publishes nothing. All money/lock logic lives in `@balo/db` — this stays thin.
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

const logger = createLogger('credit-session-meter-sweep');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Force-end a still-live session that has run past the safety cap. */
async function enforceMaxDuration(session: CreditSession, now: Date): Promise<void> {
  if ((session.status !== 'active' && session.status !== 'grace') || session.connectedAt === null) {
    return;
  }
  const elapsedMinutes = Math.floor(
    (now.getTime() - session.connectedAt.getTime()) / MS_PER_MINUTE
  );
  if (elapsedMinutes >= MAX_SESSION_MINUTES) {
    logger.warn(
      { sessionId: session.id, elapsedMinutes },
      'Session exceeded MAX_SESSION_MINUTES — force-ending'
    );
    // System force-end — the reaper is the system, not an actor, so it bypasses the actor
    // authorization `endSession` applies (a departed initiating member must not strand the session).
    await endSessionAsSystem(session.id, { now });
  }
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

/** The sweep body (exported for unit testing without a Redis-backed Worker). */
export async function runSessionMeterSweep(
  now: Date,
  log: (message: string) => void = () => {}
): Promise<{
  metered: number;
  ended: number;
  cancelled: number;
  reconciled: number;
  recovered: number;
}> {
  const metered = await runMeterPass(now, log);
  const ended = await runWrappedIdlePass(now, log);
  const cancelled = await runStalePendingPass(now, log);
  const reconciled = await runStuckSettlingPass(now, log);
  const recovered = await runFinalizedMissingPayoutPass(now, log);
  logger.info({ metered, ended, cancelled, reconciled, recovered }, 'Session meter sweep complete');
  return { metered, ended, cancelled, reconciled, recovered };
}

/** Start the credit-session meter sweep worker (concurrency 1 — serialised passes). */
export function startCreditSessionMeterSweepWorker(): Worker {
  return new Worker(
    CREDIT_SESSION_METER_SWEEP_QUEUE,
    async (job: Job) => {
      const { metered, ended, cancelled, reconciled, recovered } = await runSessionMeterSweep(
        new Date(),
        (m) => job.log(m)
      );
      job.log(
        `session meter sweep: ${metered} metered, ${ended} ended, ${cancelled} cancelled, ${reconciled} reconciled, ${recovered} recovered`
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
