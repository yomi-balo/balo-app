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
 * non-`case` meeting and for a Case whose client never joined.
 *
 * Five refusal codes, ALL returned from this ONE place rather than half thrown from the
 * repository (`session_not_found` / `no_meeting` / `meeting_not_terminal` / `not_presence_sourced`
 * / `already_settled`) — `settleFromPresence` deliberately does NOT verify
 * `duration_source = 'presence'` itself (a caller that skipped this wrapper would floor-settle a
 * `live_capture` session), so this is the ONE place that precondition, and the other four, are
 * checked before any money arithmetic runs.
 */
import {
  creditSessionsRepository,
  meetingPresenceRepository,
  meetingsRepository,
  type CreditFinalizationPath,
} from '@balo/db';
import { resolveMeetingSettlement, type MeetingSettlement } from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';
import {
  resolveBillingFloorMinutes,
  resolveBillingFloorMs,
  resolveMaxBillableMinutes,
} from '../../config/billing-floor.js';
import { finalizeBilling } from './finalize-billing.js';
import { finalizeAndSettle } from './end-session.js';
import type { EndSessionServiceResult } from './types.js';

const log = createLogger('credit-session');

/** BAL-412 (plan §2.1) — this presence-settlement path's own finalization label. */
const PRESENCE_FINALIZATION_PATH: CreditFinalizationPath = 'presence';

export type SettleFromPresenceCode =
  | 'session_not_found'
  | 'no_meeting'
  | 'meeting_not_terminal'
  | 'not_presence_sourced'
  | 'already_settled';

export interface SettleFromPresenceOk {
  readonly ok: true;
  readonly settlement: MeetingSettlement;
  readonly result: EndSessionServiceResult;
}
export type SettleFromPresenceResult =
  | SettleFromPresenceOk
  | { readonly ok: false; readonly code: SettleFromPresenceCode };

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
}): Promise<SettleFromPresenceResult> {
  const now = input.now ?? new Date();
  const { sessionId, actorUserId } = input;

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

  // ONE read for both the clocks AND `clientSideEverPresent` (`settlementFacts`'s whole reason
  // for existing over `clocks()` — see that method's docblock). The SAME ceiling instant —
  // `meeting.endedAt`, falling back to `now` only for a legacy row with no stamped end — used
  // for both reductions.
  const ceiling = meeting.endedAt ?? now;
  const { clocks, facts } = await meetingPresenceRepository.settlementFacts(meeting.id, ceiling);

  const settlement = resolveMeetingSettlement({
    clocks,
    scheduledStart: meeting.scheduledStart,
    clientSideEverPresent: facts.clientSideEverPresent,
    floorMs: resolveBillingFloorMs(),
    minutesAlreadyDrawn: session.lastTickSeq,
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
        sessionId: session.id,
        meetingId: meeting.id,
        shape: settlement.shape,
        uncappedRuleMinutes: settlement.uncappedRuleMinutes,
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
        sessionId: session.id,
        meetingId: meeting.id,
        shape: settlement.shape,
        ruleMinutes: settlement.ruleMinutes,
        minutesAlreadyDrawn: session.lastTickSeq,
        billableMinutes: settlement.billableMinutes,
      },
      'Presence settlement clamped UP to minutes already drawn — the no-refund rule (Q1). On ' +
        '`held`/`no_show_client` this is the KNOWN LIMITATION (expert drops mid-call, client ' +
        'holds the room — a real overcharge, unmitigated as of BAL-466); on the two zero shapes ' +
        'it is a pure data-integrity fault (ticks were posted for a session that should never ' +
        'have connected).'
    );
  }

  const repoResult = await creditSessionsRepository.settleFromPresence({
    sessionId: session.id,
    meetingId: meeting.id,
    billableMinutes: settlement.billableMinutes,
    actualMinutes: settlement.actualMinutes,
    billingFloorMinutes: resolveBillingFloorMinutes(),
    topUpFromTickSeq: settlement.topUpFromTickSeq,
    topUpToTickSeq: settlement.topUpToTickSeq,
    // ⚠ F2 — THE TOCTOU ANCHOR. The SAME `lastTickSeq` fed to `resolveMeetingSettlement` above,
    // handed to the repository so it can assert under the row lock that the meter has not moved
    // it since this pre-read. `findMeterable` includes `'presence'` by design, so that is a real
    // concurrent writer; on divergence the repository throws `SettlementDrawDivergedError`,
    // writes nothing, and the durability backstop re-runs this whole function against fresh
    // state. See `SettleFromPresenceRepoInput.minutesAlreadyDrawn`.
    minutesAlreadyDrawn: session.lastTickSeq,
    shape: settlement.shape,
    // ⚠ F14 — THE CORE'S ANSWER (`ruleMinutes > actualMinutes`), THREADED, NOT RE-DERIVED. The
    // repository must not recompute it as `billableMinutes > actualMinutes`: that is post-Q1-clamp
    // and would label a no-refund clamp as a floor application in both the audit row and the
    // `floored:` metric.
    floorApplied: settlement.floorApplied,
    outcome: settlement.outcome,
    actorUserId,
    now,
  });

  if (repoResult.alreadySettled) {
    // A genuine TOCTOU race — the repository's row lock, not this pre-read, caught it. Mirror
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
      { meetingId: meeting.id, sessionId: session.id, outcome: settlement.outcome },
      'Outcome already resolved — settlement did not overwrite it'
    );
  }

  const result = await finalizeAndSettle(
    repoResult.session,
    repoResult.overdraftMinor,
    repoResult.mandateActive,
    PRESENCE_FINALIZATION_PATH,
    now
  );

  // F15 / plan §8.1 / CLAUDE.md (payment events are a mandatory `log.info`) — THE SUCCESS RECORD.
  // ⚠ This path ships INERT (D10): when BAL-466 turns it on, these structured logs are the ONLY
  // production evidence it ran at all. A silent money path is undebuggable.
  log.info(
    {
      sessionId: session.id,
      meetingId: meeting.id,
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
 * The MEETING-grain entry point the terminal paths call — `end-meeting.ts` and
 * `meeting-lifecycle-sweep.ts` both know a `meetingId`, never a `sessionId`. Resolves the
 * meeting's live credit session and delegates. A meeting with no session — every non-`case`
 * meeting, and a Case whose client never joined — returns `{ ok: false, code: 'no_meeting' }`
 * and touches nothing.
 *
 * ⚠⚠ **SYSTEM-ONLY. NEVER CALL THIS FROM A ROUTE** (F7) — it is a thin `meetingId`-keyed alias
 * for {@link settleSessionFromPresence} and inherits every word of that warning: no actor
 * authorization, `actorUserId` is unvalidated attribution only, and the same
 * `finalizeAndSettle` → `settleOverdraft` off-session charge tail against the company's stored
 * mandate. Its three callers — `end-meeting.ts`, `meeting-lifecycle-sweep.ts` and the
 * `credit-session-meter-sweep.ts` durability backstop — are all system paths, and a fourth must
 * be too.
 */
export async function settleMeetingIfBillable(input: {
  readonly meetingId: string;
  readonly actorUserId: string | null;
  readonly now?: Date;
}): Promise<SettleFromPresenceResult> {
  const found = await creditSessionsRepository.findIdByMeetingId(input.meetingId);
  if (found === undefined) {
    return { ok: false, code: 'no_meeting' };
  }
  return settleSessionFromPresence({
    sessionId: found.id,
    actorUserId: input.actorUserId,
    now: input.now,
  });
}
