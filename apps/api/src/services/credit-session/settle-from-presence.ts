/**
 * BAL-412 (ADR-1044 §7, plan §2.1/§2.7) — THE PRESENCE-SETTLEMENT SERVICE WRAPPER.
 *
 * A THIN I/O shell around `resolveMeetingSettlement` (`@balo/shared/credit`, the pure core) and
 * `creditSessionsRepository.settleFromPresence` (the one transaction). It does NO minute
 * arithmetic of its own — every number it writes came out of the pure core, computed from
 * `meetingPresenceRepository.settlementFacts`.
 *
 * ⚠⚠ BAL-466 wires the enabling condition. Reachable from a `duration_source='presence'`
 * session, which `joinMeetingAsMember` now opens when the first CLIENT-side member is admitted
 * to a `case` meeting. Both call sites — `end-meeting.ts` and `meeting-lifecycle-sweep.ts` —
 * invoke this BEST-EFFORT and NON-FATAL, the same posture as `tearDownRoom`, so a settlement
 * fault can never fail an End request or abort a sweep tick. `credit-session-meter-sweep.ts`'s
 * durability-backstop pass (§4.3) is what recovers a meeting that ended with an unsettled
 * session when the best-effort call itself failed. Still returns `no_meeting` for every
 * meeting that has no session — a sessionless Case meeting is opened AND settled by
 * `settleSessionlessCaseMeeting` instead (BAL-474).
 *
 * Five refusal codes, ALL returned from this ONE place rather than half thrown from the
 * repository (`session_not_found` / `no_meeting` / `meeting_not_terminal` / `not_presence_sourced`
 * / `already_settled`) — `settleFromPresence` deliberately does NOT verify
 * `duration_source = 'presence'` itself (a caller that skipped this wrapper would floor-settle a
 * `live_capture` session), so this is the ONE place that precondition, and the other four, are
 * checked before any money arithmetic runs.
 *
 * ⚠ BAL-474 (ADR-1040 Amendment 7 §C.6) — THE FLOW IS DECOMPOSED INTO THREE REUSABLE PIECES so the
 * sessionless Case-meeting open (`settle-sessionless-case-meeting.ts`) settles through the SAME
 * path, never a second one (pinned by `invariants/expert-paid-for-time-made-available.test.ts`):
 * {@link computeMeetingPresenceSettlement} (the pure core + its two loud checks),
 * {@link buildSettlementRepoFields} (the repository input) and {@link completePresenceSettlement}
 * (the post-commit tail). This wrapper composes them in exactly the order it always ran.
 */
import {
  InvalidSessionTransitionError,
  creditSessionsRepository,
  meetingPresenceRepository,
  meetingsRepository,
  type CreditFinalizationPath,
  type SettleFromPresenceRepoInput,
  type SettleFromPresenceRepoResult,
} from '@balo/db';
import {
  caseClosedBeforeStart,
  resolveMeetingSettlement,
  type MeetingSettlement,
} from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';
import {
  resolveBillingFloorMinutes,
  resolveBillingFloorMs,
  resolveMaxBillableMinutes,
} from '../../config/billing-floor.js';
import { resolveCaseBillingSubject } from './case-billing-subject.js';
import { onlyExpertInvitedGuestsAttended } from './expert-invited-guest-guard.js';
import { finalizeBilling } from './finalize-billing.js';
import { finalizeAndSettle } from './end-session.js';
import { reportOwnerlessPriorDebt } from './debt-owner-alarm.js';
import type { EndSessionServiceResult } from './types.js';

const log = createLogger('credit-session');

/** BAL-412 (plan §2.1) — this presence-settlement path's own finalization label. */
const PRESENCE_FINALIZATION_PATH: CreditFinalizationPath = 'presence';

export type SettleFromPresenceCode =
  | 'session_not_found'
  | 'no_meeting'
  | 'meeting_not_terminal'
  | 'not_presence_sourced'
  | 'already_settled'
  /**
   * BAL-474 (D12.1c) — a NO-SHOW whose case the client closed BEFORE the meeting started: the session
   * was released (cancelled, hold released) and the meeting marked `not_billable`. TERMINAL, never
   * retried, never a warning — the callers log it at `info`.
   */
  | 'released_closed_case_no_show'
  /**
   * BAL-474 (R6F-4c, ADR-1040 Amendment 7 §E) — a `held` call attended ONLY by client-party guests the
   * delivering expert invited: the session was released (cancelled, hold released) and the meeting marked
   * `not_billable` / `expert_invited_guest_only`, exactly as the sessionless path marks it. TERMINAL, never
   * retried, never an error — the callers log it at `info`.
   */
  | 'released_expert_invited_guest_only';

export interface SettleFromPresenceOk {
  readonly ok: true;
  readonly settlement: MeetingSettlement;
  readonly result: EndSessionServiceResult;
}
export type SettleFromPresenceResult =
  | SettleFromPresenceOk
  | { readonly ok: false; readonly code: SettleFromPresenceCode };

/** The meeting fields the presence settlement reads. */
export interface PresenceSettlementMeeting {
  readonly id: string;
  readonly scheduledStart: Date;
  /** `null` only for a legacy row with no stamped end — `now` stands in as the ceiling. */
  readonly endedAt: Date | null;
}

/**
 * BAL-474 (plan §C.2 / §C.6) — the PURE-CORE half of a presence settlement: ONE read for the
 * clocks AND `clientSideEverPresent`, the SAME ceiling instant for both reductions, the pure
 * `resolveMeetingSettlement`, and the two loud checks (the F1 cap, the Q1 no-refund clamp).
 * Extracted from {@link settleSessionFromPresence} so the sessionless open computes its SHAPE
 * (before any refusal branch — D7.5) through exactly the same code. `sessionId` is `null` when no
 * session exists yet; it only labels the loud logs.
 */
export async function computeMeetingPresenceSettlement(input: {
  readonly meeting: PresenceSettlementMeeting;
  readonly sessionId: string | null;
  readonly minutesAlreadyDrawn: number;
  readonly now: Date;
  /**
   * R6F-4a — the delivering expert's profile id, resolved LAZILY: only read when a client-party guest row
   * exists, so the pre-start together term can drop the guests that expert invited.
   */
  readonly resolveExpertProfileId: () => Promise<string | null>;
}): Promise<MeetingSettlement> {
  const { meeting, sessionId, minutesAlreadyDrawn, now, resolveExpertProfileId } = input;

  // ONE read for the clocks (over start-clamped intervals), `clientSideEverPresent`, and the time
  // TOGETHER before the start (Rule A) — see `settlementFacts`'s docblock. The SAME ceiling instant —
  // `meeting.endedAt`, falling back to `now` only for a legacy row with no stamped end — used for
  // every reduction.
  const ceiling = meeting.endedAt ?? now;
  const { clocks, facts, togetherBeforeStartMs, expertPresentFromStartMs } =
    await meetingPresenceRepository.settlementFacts(meeting.id, {
      scheduledStart: meeting.scheduledStart,
      now: ceiling,
      resolveExpertProfileId,
    });

  const settlement = resolveMeetingSettlement({
    clocks,
    togetherBeforeStartMs,
    expertPresentFromStartMs,
    scheduledStart: meeting.scheduledStart,
    clientSideEverPresent: facts.clientSideEverPresent,
    floorMs: resolveBillingFloorMs(),
    minutesAlreadyDrawn,
    // ⚠ F1 — THE UPPER BOUND, injected at this boundary exactly like the floor. The pure core
    // reads no constant; without this a presence span nothing else caps (see
    // `resolveMeetingSettlement`'s docblock) becomes an unbounded off-session charge.
    maxBillableMinutes: resolveMaxBillableMinutes(),
  });

  // ⚠⚠ F1 — THE UPPER BOUND BINDING, MADE LOUD. A settlement pinned at the cap means the
  // presence data described a call longer than any legitimate consultation — an expert who left
  // the tab open, or a presence row that was never closed. The charge is held AT the cap and the
  // discrepancy is recorded here rather than swallowed.
  if (settlement.uncappedRuleMinutes > settlement.ruleMinutes) {
    log.error(
      {
        sessionId,
        meetingId: meeting.id,
        shape: settlement.shape,
        uncappedRuleMinutes: settlement.uncappedRuleMinutes,
        togetherBeforeStartMs: settlement.togetherBeforeStartMs,
        maxBillableMinutes: resolveMaxBillableMinutes(),
        ruleMinutes: settlement.ruleMinutes,
        billableMinutes: settlement.billableMinutes,
      },
      'Presence settlement CAPPED at maxBillableMinutes — the presence span exceeded the ' +
        'per-session ceiling (F1). The charge was held at the cap; investigate the presence rows ' +
        'for this meeting (an expert who never left the room, or an unclosed interval).'
    );
  }

  // ⚠⚠ Q1 — THE NO-REFUND CLAMP FIRING, MADE LOUD. See `resolveMeetingSettlement`'s docblock:
  // this is a REAL overcharge path (the expert's connection drops mid-call while the client
  // holds the room open), not merely a data-integrity fault. BAL-466 makes `presence` sessions
  // live WITHOUT building the refund primitive this would need — a known, accepted residual
  // risk, surfaced here rather than silently absorbed.
  if (settlement.billableMinutes > settlement.ruleMinutes) {
    log.error(
      {
        sessionId,
        meetingId: meeting.id,
        shape: settlement.shape,
        ruleMinutes: settlement.ruleMinutes,
        minutesAlreadyDrawn,
        billableMinutes: settlement.billableMinutes,
      },
      'Presence settlement clamped UP to minutes already drawn — the no-refund rule (Q1). On ' +
        '`held`/`no_show_client` this is the KNOWN LIMITATION (expert drops mid-call, client ' +
        'holds the room — a real overcharge, unmitigated as of BAL-466); on the two zero shapes ' +
        'it is a pure data-integrity fault (ticks were posted for a session that should never ' +
        'have connected).'
    );
  }

  return settlement;
}

/**
 * BAL-474 — the repository input the pure core's answer becomes, minus the two ids. Extracted so
 * `settleFromPresence` and `openAndSettleFromPresence` are handed byte-identical figures.
 *
 * `minutesAlreadyDrawn` is the F2 TOCTOU ANCHOR: the SAME `lastTickSeq` fed to
 * `resolveMeetingSettlement`, handed to the repository so it can assert under the row lock that the
 * meter has not moved it since the caller's pre-read (`SettlementDrawDivergedError`).
 * `floorApplied` is the core's answer (`ruleMinutes > actualMinutes`), THREADED, NOT RE-DERIVED — the
 * repository must not recompute it as `billableMinutes > actualMinutes` (post-Q1-clamp, that would
 * label a no-refund clamp as a floor application in both the audit row and the `floored:` metric).
 */
export function buildSettlementRepoFields(
  settlement: MeetingSettlement,
  ctx: {
    readonly minutesAlreadyDrawn: number;
    /** ADR-1030; `null` = the system-actor exemption. */
    readonly actorUserId: string | null;
    readonly now: Date;
  }
): Omit<SettleFromPresenceRepoInput, 'sessionId' | 'meetingId'> {
  return {
    billableMinutes: settlement.billableMinutes,
    actualMinutes: settlement.actualMinutes,
    billingFloorMinutes: resolveBillingFloorMinutes(),
    topUpFromTickSeq: settlement.topUpFromTickSeq,
    topUpToTickSeq: settlement.topUpToTickSeq,
    minutesAlreadyDrawn: ctx.minutesAlreadyDrawn,
    shape: settlement.shape,
    floorApplied: settlement.floorApplied,
    outcome: settlement.outcome,
    actorUserId: ctx.actorUserId,
    now: ctx.now,
  };
}

/**
 * BAL-474 — the POST-COMMIT TAIL of a presence settlement: everything after the repository's
 * transaction. Extracted so a session opened-and-settled in one transaction finishes through the
 * SAME code — the `alreadySettled` replay, the outcome log, the ownerless-debt alarm, the
 * `finalizeAndSettle` receipts / charge / receivable, and the success record.
 */
export async function completePresenceSettlement(input: {
  readonly repoResult: SettleFromPresenceRepoResult;
  readonly settlement: MeetingSettlement;
  readonly meetingId: string;
  readonly sessionId: string;
  readonly now: Date;
}): Promise<SettleFromPresenceOk> {
  const { repoResult, settlement, meetingId, sessionId, now } = input;

  if (repoResult.alreadySettled) {
    // A genuine TOCTOU race — the repository's row lock, not a pre-read, caught it. Mirror
    // `endSessionAsSystem`'s `alreadyEnded` arm rather than re-running `finalizeAndSettle`, which
    // would re-publish the settled receipt / re-fire auto-top-up for a session somebody else
    // (the other best-effort caller) already finalized. Only replay the BAL-399 durability
    // story — booking a stranded payout obligation — and only for a row finalized under BAL-399
    // semantics (a legacy row has `billingFinalizedAt` NULL and must not get a late payout).
    if (repoResult.session.billingFinalizedAt !== null) {
      await finalizeBilling(
        repoResult.session,
        repoResult.session.finalizationPath ?? PRESENCE_FINALIZATION_PATH,
        now
      );
    }
    return {
      ok: true,
      settlement,
      result: {
        settlementStatus: repoResult.session.settlementStatus,
        overdraftSettledMinor: repoResult.session.overdraftSettledMinor ?? 0,
      },
    };
  }

  // F15 — `meetingsRepository.setOutcomeIfUnset`'s docblock EXPLICITLY DELEGATES this log to
  // the caller ("The CALLER logs the `false` case — this repository does not log."). Benign in
  // the common case (the lifecycle sweep already resolved `missed_call`), but it is also the
  // only signal that settlement and the sweep disagreed about what happened.
  if (!repoResult.outcomeWritten) {
    log.info(
      { meetingId, sessionId, outcome: settlement.outcome },
      'Outcome already resolved — settlement did not overwrite it'
    );
  }

  // BAL-474 (D7.3) — the share's basis and the ownerless-debt reading taken INSIDE the terminal
  // transaction. Its OWN line (never new keys on the success record below, whose exact key set an
  // existing test pins), and the alarm fires BEFORE the tail so a tail fault cannot swallow it.
  log.info(
    { sessionId, openedBy: repoResult.session.openedBy, overdraftBasis: repoResult.overdraftBasis },
    'Presence settlement basis'
  );
  reportOwnerlessPriorDebt({
    sessionId,
    walletId: repoResult.session.walletId,
    companyId: repoResult.session.companyId,
    basis: repoResult.overdraftBasis,
  });

  const result = await finalizeAndSettle(
    repoResult.session,
    repoResult.overdraftMinor,
    repoResult.mandateActive,
    PRESENCE_FINALIZATION_PATH,
    now
  );

  // F15 / plan §8.1 / CLAUDE.md (payment events are a mandatory `log.info`) — THE SUCCESS RECORD.
  // ⚠⚠ G4 (second review round) — CORRECTING A NOW-FALSE CLAIM: this used to say "This path
  // ships INERT (D10): when BAL-466 turns it on, these structured logs are the ONLY production
  // evidence it ran at all." BAL-466 turned it on — `joinMeetingAsMember` opens
  // `duration_source='presence'` sessions at admission, so this path runs live for every
  // settled Case consultation, and these structured logs ARE the production evidence.
  log.info(
    {
      sessionId,
      meetingId,
      shape: settlement.shape,
      outcome: settlement.outcome,
      actualMinutes: settlement.actualMinutes,
      billableMinutes: settlement.billableMinutes,
      floorApplied: settlement.floorApplied,
      ticksPosted: repoResult.ticksPosted,
      overdraftMinor: repoResult.overdraftMinor,
    },
    'Presence settlement completed'
  );
  return { ok: true, settlement, result };
}

/**
 * Settle ONE credit session from its meeting's presence rows. Idempotent; safe to retry —
 * either from this pre-read (the common case) or from the repository's own row-locked guard (a
 * genuine race between two best-effort callers).
 *
 * ⚠⚠ **SYSTEM-ONLY. NEVER CALL THIS FROM A ROUTE** (F7) — the same warning
 * `endSessionAsSystem` carries, for the same reason: it performs NO ACTOR AUTHORIZATION.
 * `actorUserId` is unvalidated ATTRIBUTION written straight into `audit_events.actor_user_id`,
 * and this function reaches the identical `finalizeAndSettle` → `settleOverdraft` OFF-SESSION
 * CHARGE tail against the company's stored mandate. It exists for the two terminal paths
 * (`end-meeting.ts`, `meeting-lifecycle-sweep.ts`) and the durability backstop
 * (`credit-session-meter-sweep.ts`) ONLY. A route reaching it would let any caller who can name
 * a `sessionId` charge that company's card with no capability check whatsoever. Route-facing
 * termination goes through `endSession`, which authorizes the actor.
 */
export async function settleSessionFromPresence(input: {
  readonly sessionId: string;
  /** ADR-1030; `null` = the system-actor exemption (the sweep path). */
  readonly actorUserId: string | null;
  readonly now?: Date;
  /** Which terminal path is settling — recorded on a closed-case release's marker. */
  readonly trigger?: string;
}): Promise<SettleFromPresenceResult> {
  const now = input.now ?? new Date();
  const { sessionId, actorUserId } = input;
  const trigger = input.trigger ?? 'presence_settlement';

  const session = await creditSessionsRepository.findById(sessionId);
  if (session === undefined) {
    return { ok: false, code: 'session_not_found' };
  }
  // Cheap early exit for the common idempotent-retry path — a settlement fault at one terminal
  // path is routinely retried by the durability backstop (§4.3) against a session the OTHER
  // terminal path already finalized. The repository's row lock (`settleFromPresence` step 2) is
  // the real TOCTOU guard; this pre-read only avoids recomputing settlement arithmetic for a
  // session that plainly needs nothing further. A legacy `ended` row with a NULL marker also
  // counts as settled — it was finalized by `end()` under the old (pre-BAL-412) semantics.
  if (session.billingFinalizedAt !== null || session.status === 'ended') {
    return { ok: false, code: 'already_settled' };
  }
  if (session.durationSource !== 'presence') {
    return { ok: false, code: 'not_presence_sourced' };
  }
  if (session.meetingId === null) {
    return { ok: false, code: 'no_meeting' };
  }

  const meeting = await meetingsRepository.findById(session.meetingId);
  if (meeting === undefined) {
    return { ok: false, code: 'no_meeting' };
  }
  // D3 / the `meeting_outcome_requires_ended` CHECK — the write-side order is discharged by this
  // precondition, not by sequencing inside the transaction: settlement never runs against a
  // meeting that is not yet `ended`.
  if (meeting.status !== 'ended') {
    return { ok: false, code: 'meeting_not_terminal' };
  }

  const settlement = await computeMeetingPresenceSettlement({
    meeting,
    sessionId: session.id,
    minutesAlreadyDrawn: session.lastTickSeq,
    now,
    resolveExpertProfileId: async () => session.expertProfileId,
  });

  // BAL-474 (D12.1c, security N4) — a NO-SHOW on a case the client closed BEFORE the meeting started
  // owes nothing: release the never-connected session instead of charging the floor to a client who
  // resolved the case before anyone was due. An ATTENDED call (`held`) never reaches this.
  if (settlement.shape === 'no_show_client') {
    const released = await releaseIfClosedCaseNoShow({ session, meeting, settlement, trigger });
    if (released) {
      return { ok: false, code: 'released_closed_case_no_show' };
    }
  }

  // BAL-474 (R6F-4c, ADR-1040 Amendment 7 §E) — "not after the call": a `held` call whose ONLY client-side
  // attendees were guests the delivering expert invited is not billed on the client, whether or not a session
  // already existed. The sessionless path applies the same guard and the same marker.
  if (settlement.shape === 'held') {
    const released = await releaseIfExpertInvitedGuestsOnly({
      session,
      meeting,
      settlement,
      trigger,
    });
    if (released) {
      return { ok: false, code: 'released_expert_invited_guest_only' };
    }
  }

  const repoResult = await creditSessionsRepository.settleFromPresence({
    sessionId: session.id,
    meetingId: meeting.id,
    ...buildSettlementRepoFields(settlement, {
      minutesAlreadyDrawn: session.lastTickSeq,
      actorUserId,
      now,
    }),
  });

  return completePresenceSettlement({
    repoResult,
    settlement,
    meetingId: meeting.id,
    sessionId: session.id,
    now,
  });
}

/**
 * BAL-474 (D12.1c, security N4) — the EXISTING-SESSION half of the closed-case rule: a `no_show_client`
 * settlement on a case closed before the start RELEASES the session (`cancel`, which releases the hold
 * under the wallet lock it takes itself) and writes the `not_billable` / `case_closed_before_start`
 * marker (which also resolves `meetings.outcome` first-write-wins, in its own transaction).
 *
 * Why the cancel succeeds: a no-show's session is always `pending` — connecting needs co-presence, and
 * co-presence makes the shape `held`. If `cancel` throws `InvalidSessionTransitionError` anyway, that
 * is an invariant violation: log `error` and return `false` so the normal settlement runs. A crash
 * between the cancel and the marker leaves a SESSIONLESS ended meeting, which the durability backstop
 * re-runs and the sessionless path marks the same way.
 */
interface ReleaseInput {
  readonly session: {
    readonly id: string;
    readonly initiatingMemberId: string;
    readonly expertProfileId: string;
  };
  readonly meeting: { readonly id: string; readonly scheduledStart: Date };
  readonly settlement: MeetingSettlement;
  readonly trigger: string;
}

/**
 * Release the session (`cancel`, which releases the hold under the wallet lock it takes itself) and write the
 * `not_billable` marker (which also resolves `meetings.outcome` first-write-wins, in its own transaction).
 * `false` when the session was not `pending` — the caller then settles normally, after this logs at `error`.
 */
async function cancelAndMarkNotBillable(
  input: ReleaseInput & {
    readonly reason: 'case_closed_before_start' | 'expert_invited_guest_only';
    readonly notPendingMessage: string;
    readonly releasedLevel: 'info' | 'warn';
    readonly releasedMessage: string;
  }
): Promise<boolean> {
  const { session, meeting, settlement, trigger, reason } = input;
  try {
    await creditSessionsRepository.cancel(session.id, { memberId: session.initiatingMemberId });
  } catch (error) {
    if (error instanceof InvalidSessionTransitionError) {
      log.error(
        {
          sessionId: session.id,
          meetingId: meeting.id,
          error: error.message,
          stack: error.stack,
        },
        input.notPendingMessage
      );
      return false;
    }
    throw error;
  }
  await creditSessionsRepository.markSessionlessCaseMeeting({
    meetingId: meeting.id,
    disposition: 'not_billable',
    reason,
    trigger,
    shape: settlement.shape,
    outcome: settlement.outcome,
  });
  log[input.releasedLevel](
    { sessionId: session.id, meetingId: meeting.id, trigger },
    input.releasedMessage
  );
  return true;
}

async function releaseIfClosedCaseNoShow(input: ReleaseInput): Promise<boolean> {
  const subject = await resolveCaseBillingSubject(input.meeting.id, { requireActive: false });
  if (subject === undefined || !caseClosedBeforeStart(subject, input.meeting.scheduledStart)) {
    return false;
  }
  return cancelAndMarkNotBillable({
    ...input,
    reason: 'case_closed_before_start',
    notPendingMessage:
      'A no-show session on a case closed before the start could not be released (it was not pending) — settling it normally',
    releasedLevel: 'info',
    releasedMessage:
      'No-show on a case closed before the start — the session was released, nothing is owed',
  });
}

/**
 * BAL-474 (R6F-4c) — the EXISTING-SESSION half of the expert-invited-guest rule (ADR-1040 Amendment 7 §E: such
 * a guest "does not open or bill a session: not at admission, not when billing starts, and not after the
 * call"). Same guard, same marker reason and same `warn` as the sessionless path's `NOTHING_OWED` entry.
 * A session that already connected (only reachable for a call whose meter started before the seam applied the
 * guard) cannot be cancelled: that logs `error` and settles normally.
 */
async function releaseIfExpertInvitedGuestsOnly(input: ReleaseInput): Promise<boolean> {
  if (!(await onlyExpertInvitedGuestsAttended(input.meeting.id, input.session.expertProfileId))) {
    return false;
  }
  return cancelAndMarkNotBillable({
    ...input,
    reason: 'expert_invited_guest_only',
    notPendingMessage:
      'A held call attended only by guests the delivering expert invited could not be released (the session was not pending) — settling it normally',
    releasedLevel: 'warn',
    releasedMessage:
      'Held call attended only by guests the delivering expert invited — the session was released, not billed on the client',
  });
}

/**
 * The MEETING-grain entry point the terminal paths call — `end-meeting.ts` and
 * `meeting-lifecycle-sweep.ts` both know a `meetingId`, never a `sessionId`. Resolves the
 * meeting's live credit session and delegates. A meeting with no session returns
 * `{ ok: false, code: 'no_meeting' }` and touches nothing — BAL-474's
 * `settleSessionlessCaseMeeting` is what OPENS and settles a sessionless Case meeting.
 *
 * ⚠⚠ **SYSTEM-ONLY. NEVER CALL THIS FROM A ROUTE** (F7) — it is a thin `meetingId`-keyed alias
 * for {@link settleSessionFromPresence} and inherits every word of that warning: no actor
 * authorization, `actorUserId` is unvalidated attribution only, and the same
 * `finalizeAndSettle` → `settleOverdraft` off-session charge tail against the company's stored
 * mandate. Its callers — `settleSessionlessCaseMeeting` and the `credit-session-meter-sweep.ts`
 * durability backstop — are all system paths, and a fourth must be too.
 */
export async function settleMeetingIfBillable(input: {
  readonly meetingId: string;
  readonly actorUserId: string | null;
  readonly now?: Date;
  readonly trigger?: string;
}): Promise<SettleFromPresenceResult> {
  const found = await creditSessionsRepository.findIdByMeetingId(input.meetingId);
  if (found === undefined) {
    return { ok: false, code: 'no_meeting' };
  }
  return settleSessionFromPresence({
    sessionId: found.id,
    actorUserId: input.actorUserId,
    now: input.now,
    ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
  });
}
