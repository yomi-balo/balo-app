/**
 * BAL-421 — the CASE SURFACE's pure core: which single nudge the header shows, and which
 * state each consultation row renders in.
 *
 * PURE and dependency-free — no `@balo/db`, no `postgres`, no I/O, no clock of its own, and
 * deliberately NO `server-only` (that import is what crash-looped Railway on PR #191; see
 * `packages/shared/src/meetings/context-owner.ts`). Bundle-safe in a client graph.
 *
 * ⚠⚠ THE PARAM TYPES ARE STRUCTURAL, NEVER `@balo/db`'s ROW TYPES — the load-bearing half of
 * the BAL-423 / BAL-129 precedent. `meetingContextsRepository.listMeetingsForContext` returns
 * FULL `Meeting` rows carrying `dailyRoomName` and `joinUrl`; a rule that accepted one would
 * put a live room locator one careless spread away from a client bundle. Everything here takes
 * the two or three fields it actually reads.
 *
 * ⚠ NO INJECTED FINDERS, AND THAT IS A CONSIDERED DEVIATION FROM A LITERAL READING OF THE
 * PRECEDENT (flagged, not taken silently). `context-owner.ts` injects because its rule must
 * perform async reads to answer at all. BOTH functions here are SYNCHRONOUS and perform no
 * I/O — the loader already holds every row before it calls them — so a finder-injection
 * ceremony would add indirection without adding a testable seam. Where injection IS genuinely
 * required on this ticket (the engagement-axis host-context assembly), it IS used: see
 * `buildHostContextForExpertProfile` in `../authz/engagement.ts`.
 */

import { rescheduleProposalIsLive } from '../meetings';

// ── The nudge ────────────────────────────────────────────────────────────────────────────

/**
 * How close to `scheduled_start` a consultation counts as LIVE — i.e. the join affordance
 * lights up and the nudge shows its pulsing dot.
 *
 * ⚠ A CONSTANT, NOT CONFIG. `platform_config` is not on `main` (its PR is unmerged), so a
 * typed constant is what "configurable" means today — the same ruling `load-recap.ts` records
 * for `PIPELINE_GRACE_MS`.
 */
export const CASE_JOIN_WINDOW_MINUTES = 15;

const MS_PER_MINUTE = 60_000;

/** The next scheduled consultation, narrowed to the two fields the nudge reads. */
export interface CaseNudgeUpcoming {
  readonly meetingId: string;
  readonly scheduledStart: Date;
}

/**
 * BAL-411 — the meeting's pending reschedule proposal, or `null`. Liveness (expiry) is decided
 * HERE via {@link rescheduleProposalIsLive}, so the loader and the nudge cannot disagree.
 * Staleness (the client having moved the meeting out from under a pending proposal, BAL-409) is
 * NOT decided here — it is derived at ANSWER time, against the meeting's LIVE `scheduled_start`,
 * by `resolveProposalAnswerRefusal`; the nudge has no need to distinguish "live" from "live but
 * stale" because a stale proposal is still exactly what the expert is waiting on an answer to.
 */
export interface CaseNudgeRescheduleProposal {
  readonly proposalId: string;
  readonly meetingId: string;
  readonly optionCount: number;
  readonly originalScheduledStart: Date;
  readonly expiresAt: Date;
}

export interface CaseNudgeInput {
  /** The viewer's resolved SIDE. NEVER `users.activeMode` (a view toggle — ADR-1029). */
  readonly lens: 'client' | 'expert';
  /** `case_engagements.closed_at IS NULL`. */
  readonly isOpen: boolean;
  /** The soonest `scheduled` / `waiting_for_participants` consultation, or `null`. */
  readonly nextScheduled: CaseNudgeUpcoming | null;
  /** `case_engagements.resolution_requested_at`. */
  readonly resolutionRequestedAt: Date | null;
  /** BAL-411 — the LIVE meeting's pending reschedule proposal, or `null`. See
   *  {@link CaseNudgeRescheduleProposal}. */
  readonly rescheduleProposal: CaseNudgeRescheduleProposal | null;
  readonly now: Date;
}

export type CaseNudge =
  | {
      readonly kind: 'upcoming';
      readonly meetingId: string;
      readonly scheduledStart: Date;
      /** Inside `CASE_JOIN_WINDOW_MINUTES` of the start — the pulse + live dot. */
      readonly live: boolean;
    }
  /** CLIENT lens — the expert asked to move it, and only the client can answer by accepting or
   *  declining. BAL-411. */
  | {
      readonly kind: 'reschedule_proposal';
      readonly proposalId: string;
      readonly meetingId: string;
      readonly optionCount: number;
      readonly originalScheduledStart: Date;
      readonly expiresAt: Date;
    }
  /** EXPERT lens — their own reschedule proposal is outstanding. BAL-411. */
  | {
      readonly kind: 'reschedule_proposal_pending';
      readonly proposalId: string;
      readonly meetingId: string;
      readonly optionCount: number;
      readonly expiresAt: Date;
    }
  /** CLIENT lens only — the expert asked, and only the client can answer by closing. */
  | { readonly kind: 'resolution_ask' }
  /** EXPERT lens only — their own ask is outstanding. */
  | { readonly kind: 'resolution_ask_pending' }
  | { readonly kind: 'nothing_booked' }
  /** A CLOSED case has no nudge at all — there is nothing left to prompt. */
  | null;

/** True from `CASE_JOIN_WINDOW_MINUTES` before the start onwards. Inclusive at the boundary. */
function withinJoinWindow(now: Date, scheduledStart: Date): boolean {
  return scheduledStart.getTime() - now.getTime() <= CASE_JOIN_WINDOW_MINUTES * MS_PER_MINUTE;
}

/**
 * EXACTLY ONE nudge, by a tested priority. The whole point is that the header can never stack
 * two prompts, so the ordering IS the rule and it is pinned by a table test.
 *
 * ```
 * 1. !isOpen                                       → null
 * 2. a LIVE reschedule proposal on the meeting      → client: reschedule_proposal |
 *                                                      expert: reschedule_proposal_pending
 * 3. nextScheduled !== null                         → upcoming (live iff inside the join window)
 * 4. resolutionRequestedAt !== null                 → client: resolution_ask |
 *                                                      expert: resolution_ask_pending
 * 5. otherwise                                       → nothing_booked
 * ```
 *
 * ⚠ ARM 1 STAYS FIRST, ABOVE THE RESCHEDULE-PROPOSAL ARM. "A CLOSED case has no nudge at all —
 * there is nothing left to prompt" is a stronger rule than a live proposal: a proposal cannot
 * legitimately outlive the case closing (propose requires an OPEN case, §D8), but a client-side
 * close racing an in-flight proposal must still win, and asking a client to answer a proposal on
 * a case nobody can act on any more is not a prompt worth showing.
 *
 * ⚠ ARM 2 SITS ABOVE `upcoming` (BAL-411), AND SUPPRESSES IT. Showing "your call is at 3pm"
 * while the expert has asked to move it is actively misleading, and the header can only ever
 * carry one prompt — so a live proposal suppresses `upcoming` and, with it, the client's own
 * "Reschedule" CTA: one negotiation over a booking at a time.
 *
 * ⚠ ARM 3 SITTING ABOVE ARM 4 **IS** THE "ask is suppressed while anything is booked" RULE.
 * "Is this resolved?" contradicts a call the two parties have already agreed to hold. It falls
 * out of the ordering — do NOT add a separate suppression flag, which would be a second place
 * the same rule lives.
 */
export function selectCaseNudge(input: CaseNudgeInput): CaseNudge {
  const { lens, isOpen, nextScheduled, resolutionRequestedAt, rescheduleProposal, now } = input;

  if (!isOpen) return null;

  if (rescheduleProposal !== null && rescheduleProposalIsLive(rescheduleProposal, now)) {
    return lens === 'client'
      ? {
          kind: 'reschedule_proposal',
          proposalId: rescheduleProposal.proposalId,
          meetingId: rescheduleProposal.meetingId,
          optionCount: rescheduleProposal.optionCount,
          originalScheduledStart: rescheduleProposal.originalScheduledStart,
          expiresAt: rescheduleProposal.expiresAt,
        }
      : {
          kind: 'reschedule_proposal_pending',
          proposalId: rescheduleProposal.proposalId,
          meetingId: rescheduleProposal.meetingId,
          optionCount: rescheduleProposal.optionCount,
          expiresAt: rescheduleProposal.expiresAt,
        };
  }

  if (nextScheduled !== null) {
    return {
      kind: 'upcoming',
      meetingId: nextScheduled.meetingId,
      scheduledStart: nextScheduled.scheduledStart,
      live: withinJoinWindow(now, nextScheduled.scheduledStart),
    };
  }

  if (resolutionRequestedAt !== null) {
    return lens === 'client' ? { kind: 'resolution_ask' } : { kind: 'resolution_ask_pending' };
  }

  return { kind: 'nothing_booked' };
}

// ── The consultation state ───────────────────────────────────────────────────────────────

/**
 * Hand-restated `meeting_status` labels. `@balo/shared` CANNOT import a pgEnum — that would
 * invert the dependency graph (`@balo/db` depends on `@balo/shared`, never the reverse). The
 * two-way drift guard lives in `apps/web/.../_lib/map-case-consultations.ts`, the one module
 * that can see BOTH this union and `@balo/db`'s enum-derived type; a label added on either
 * side fails `tsc` there until it is added on the other. Same posture as
 * `EngagementStatusLabel` in `../conversations`.
 */
export type MeetingStatusLabel =
  | 'scheduled'
  | 'waiting_for_participants'
  | 'in_progress'
  | 'ended'
  | 'cancelled';

/** Hand-restated `meeting_outcome` labels — see {@link MeetingStatusLabel}. */
export type MeetingOutcomeLabel = 'completed' | 'no_show_client' | 'missed_call';

/**
 * What a consultation row renders as.
 *
 * ⚠ `no_show_client` AND `missed_call` ARE DISTINCT MEMBERS, AND BOTH RENDER DISTINCTLY.
 * They are genuinely different events — `no_show_client` means the expert waited and nobody
 * client-side arrived; `missed_call` means the EXPERT never joined (see `meetingOutcomeEnum`).
 * Folding them into one "not held" label would tell the wronged party the call failed without
 * saying who failed to show, which is the single most load-bearing fact in the row.
 *
 * ⚠ `pending_reschedule` (BAL-411) — a `scheduled` / `waiting_for_participants` consultation
 * that ALSO carries a LIVE reschedule proposal. It is nested INSIDE the `scheduled` branch of
 * {@link deriveCaseConsultationState}, never a sibling check above it — see that function's
 * own comment for why the ordering matters.
 */
export type CaseConsultationStateLabel =
  | 'scheduled'
  | 'pending_reschedule'
  | 'in_progress'
  | 'held'
  | 'no_show_client'
  | 'missed_call'
  | 'cancelled'
  | 'outcome_pending';

export interface CaseConsultationStateInput {
  readonly status: MeetingStatusLabel;
  readonly outcome: MeetingOutcomeLabel | null;
  /** BAL-411 — a LIVE (pending, unexpired) reschedule proposal exists on THIS meeting. */
  readonly hasLiveRescheduleProposal: boolean;
}

/**
 * TOTAL over every `(status, outcome, hasLiveRescheduleProposal)` triple — no fallthrough, no
 * `default: 'held'`.
 *
 * ⚠ `in_progress` AND `outcome_pending` EXIST BECAUSE BOTH ARE REPRESENTABLE, NOT AS SCOPE
 * CREEP. The CHECK `meeting_outcome_requires_ended` is ONE-DIRECTIONAL (`outcome ⇒ ended`), so
 * `ended` carrying a NULL outcome is perfectly legal in the database — a meeting that ended
 * before anything stamped why. A total function that silently folded that into `held` would
 * MISREPORT it as a delivered consultation, on a surface whose whole job is to say what
 * happened. The mapper `log.warn`s when it sees one; the row states the absence neutrally.
 *
 * ⚠ `hasLiveRescheduleProposal` IS CHECKED INSIDE THE `scheduled` BRANCH, NEVER ABOVE IT
 * (BAL-411). A proposal cannot legitimately exist on an ended/cancelled meeting — propose
 * requires `resolveRescheduleRefusal === null`, i.e. a live `scheduled` meeting — but a
 * client-side CANCEL racing an in-flight proposal would otherwise flip a `cancelled` row to
 * `pending_reschedule` if this check ran first. This function's whole contract is that it is
 * TOTAL and honest, so the check sits where it can only ever apply to a row it is true of.
 */
export function deriveCaseConsultationState(
  input: CaseConsultationStateInput
): CaseConsultationStateLabel {
  const { status, outcome, hasLiveRescheduleProposal } = input;

  if (status === 'cancelled') return 'cancelled';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'scheduled' || status === 'waiting_for_participants') {
    return hasLiveRescheduleProposal ? 'pending_reschedule' : 'scheduled';
  }

  // `status === 'ended'` — the outcome decides, and a NULL one is its own honest state.
  if (outcome === 'completed') return 'held';
  if (outcome === 'no_show_client') return 'no_show_client';
  if (outcome === 'missed_call') return 'missed_call';
  return 'outcome_pending';
}

/** A consultation is UPCOMING when it is still expected to happen. `pending_reschedule`
 *  (BAL-411) counts — the original booking stands until an option is accepted, so the
 *  consultation is still expected to happen and must not drop out of `selectNextScheduled`. */
export function caseConsultationIsUpcoming(state: CaseConsultationStateLabel): boolean {
  return state === 'scheduled' || state === 'pending_reschedule' || state === 'in_progress';
}
