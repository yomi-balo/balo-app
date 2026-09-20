import 'server-only';

import type { Meeting, MeetingOutcome, MeetingStatus } from '@balo/db';
import {
  deriveCaseConsultationState,
  type MeetingOutcomeLabel,
  type MeetingStatusLabel,
} from '@balo/shared/engagements';
import { resolveCancelRefusal, resolveRescheduleRefusal } from '@balo/shared/meetings';
import { log } from '@/lib/logging';
import { deriveConsultationOrdinal } from '@/lib/meetings/derive-consultation-ordinal';
import { insideCaseJoinWindow } from '@/lib/cases/case-join-window';
import type { CaseConsultationRowView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 — `Meeting[]` → `CaseConsultationRowView[]`. **THE PROJECTION BOUNDARY.**
 *
 * ⚠⚠ THIS IS WHERE THE CALL-JOIN CREDENTIALS STOP. `listMeetingsForContext` returns FULL
 * `Meeting` rows including `dailyRoomName` and `joinUrl` — a live room locator. Every row is
 * built FIELD BY FIELD here, never spread, so a new column added to `meetings` cannot
 * silently join the client payload. TypeScript's excess-property checking does NOT apply to
 * spreads, which is exactly how this class of leak ships unnoticed (memory
 * `reference_drizzle_with_hydration_leaks_secrets`).
 *
 * ⚠ `status` AND `outcome` ARE CONSUMED HERE AND NEVER SERIALIZED. The client receives the
 * DERIVED label. Adding either to the row "for the badge" would hand the browser the job of
 * re-deriving an outcome, which is how two surfaces start disagreeing about whether a call
 * happened.
 *
 * ⚠ ORDERING IS `deriveConsultationOrdinal`'s, REUSED AND NEVER RE-DERIVED. That module
 * already encodes the canonical rule (`COALESCE(started_at, scheduled_start) ASC, id ASC`,
 * excluding `cancelled`) and it is the same rule the recap's ordinal line renders — a second
 * implementation here would let the two surfaces number the same consultation differently.
 */

/**
 * ⚠⚠ TWO-WAY DRIFT GUARD between `@balo/db`'s enum-derived `MeetingStatus`/`MeetingOutcome`
 * and the hand-restated labels in `@balo/shared/engagements` (which CANNOT import a pgEnum —
 * that would invert the dependency graph). THIS module is one of the few that can see both.
 * A sixth `meeting_status` or a fourth `meeting_outcome` added on either side fails `tsc`
 * HERE until it is added on the other. Mirrors `AssertEngagementStatusLabelsMatch` in
 * `lib/conversations/authorize-conversation-context.ts`.
 */
type MissingStatus = Exclude<MeetingStatus, MeetingStatusLabel>;
type StrayStatus = Exclude<MeetingStatusLabel, MeetingStatus>;
type MissingOutcome = Exclude<MeetingOutcome, MeetingOutcomeLabel>;
type StrayOutcome = Exclude<MeetingOutcomeLabel, MeetingOutcome>;
type AssertNever<T extends never> = T;
export type AssertMeetingLabelsMatch = [
  AssertNever<MissingStatus>,
  AssertNever<StrayStatus>,
  AssertNever<MissingOutcome>,
  AssertNever<StrayOutcome>,
];

/** Per-meeting counts the row displays, gathered by the loader in ONE batched pass each. */
export interface CaseConsultationCounts {
  actionItemCountByMeetingId: ReadonlyMap<string, number>;
  fileCountByMeetingId: ReadonlyMap<string, number>;
  meetingIdsWithTranscript: ReadonlySet<string>;
  /** BAL-411 — meetings carrying a LIVE (pending, unexpired) reschedule proposal, gathered by
   *  the loader from `rescheduleProposalsRepository.findLivePendingByMeetingIds` +
   *  `rescheduleProposalIsLive`. Threaded into `deriveCaseConsultationState` below. */
  meetingIdsWithLiveProposal: ReadonlySet<string>;
}

export interface CaseConsultationActionContext {
  /** Decides which of `canReschedule` / `canProposeReschedule` can be true on a row; the other
   *  is structurally `false`. */
  lens: 'client' | 'expert';
  /** The loader-resolved capability — `participate` (client) or `manage_engagement` (expert) —
   *  ANDed with each row's own state below. `false` on a closed case, or when the viewer holds
   *  neither axis (e.g. a colleague with visibility only). */
  mayAct: boolean;
}

/** Whole minutes between the two stamps; `null` when either is missing (never a bare zero). */
function durationMinutesOf(meeting: Meeting): number | null {
  const { startedAt, endedAt } = meeting;
  if (startedAt === null || endedAt === null) return null;
  return Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000));
}

/**
 * `/meetings/{id}?from=case_surface` for an `ended` meeting only, `null` otherwise — including
 * `cancelled`, whose recap has no money block or artifacts, so the link would lead somewhere
 * emptier than the row itself.
 */
function recapHrefOf(meeting: Meeting): string | null {
  if (meeting.status !== 'ended') return null;
  return '/meetings/' + meeting.id + '?from=case_surface';
}

export function mapCaseConsultations(
  meetings: readonly Meeting[],
  counts: CaseConsultationCounts,
  /** Used only for the row action flags (join window, `resolveRescheduleRefusal`'s "already
   *  started" check) — never for ordering or state derivation; see `deriveConsultationOrdinal`'s
   *  own now-free purity note. */
  now: Date,
  action: CaseConsultationActionContext
): CaseConsultationRowView[] {
  const ordinalInputs = meetings.map((meeting) => ({
    id: meeting.id,
    scheduledStart: meeting.scheduledStart,
    startedAt: meeting.startedAt,
    status: meeting.status,
    outcome: meeting.outcome,
  }));

  const rows = meetings.map((meeting) => {
    const state = deriveCaseConsultationState({
      status: meeting.status,
      outcome: meeting.outcome,
      hasLiveRescheduleProposal: counts.meetingIdsWithLiveProposal.has(meeting.id),
    });

    if (state === 'outcome_pending') {
      // ⚠ REPRESENTABLE, NOT IMPOSSIBLE: `meeting_outcome_requires_ended` is one-directional,
      // so `ended` + NULL outcome is legal. The row states the absence neutrally; this warn
      // is how an un-stamped meeting stops being invisible to operations.
      log.warn('Case consultation ended with no outcome recorded', {
        meetingId: meeting.id,
        status: meeting.status,
      });
    }

    // Every flag below reads the raw `meeting.status`, never the derived `state` above: `state`
    // folds `waiting_for_participants` into `'scheduled'`, but neither
    // `CANCELLABLE_MEETING_STATUSES` nor `RESCHEDULABLE_MEETING_STATUSES` admits it.
    const live = insideCaseJoinWindow(now, meeting.scheduledStart.toISOString());
    const hasLiveProposal = counts.meetingIdsWithLiveProposal.has(meeting.id);
    const canCancel = action.mayAct && resolveCancelRefusal(meeting.status) === null;
    // `canCancel` is deliberately not blocked by a live proposal or the join window, unlike the
    // two move flags below — cancelling isn't a negotiation.
    const canMove =
      action.mayAct &&
      !live &&
      !hasLiveProposal &&
      resolveRescheduleRefusal(meeting.status, meeting.scheduledStart, now) === null;

    return {
      meetingId: meeting.id,
      ordinal: deriveConsultationOrdinal(ordinalInputs, meeting.id).ordinal,
      state,
      scheduledStartIso: meeting.scheduledStart.toISOString(),
      startedAtIso: meeting.startedAt?.toISOString() ?? null,
      durationMinutes: durationMinutesOf(meeting),
      recapHref: recapHrefOf(meeting),
      actionItemCount: counts.actionItemCountByMeetingId.get(meeting.id) ?? 0,
      fileCount: counts.fileCountByMeetingId.get(meeting.id) ?? 0,
      hasTranscript: counts.meetingIdsWithTranscript.has(meeting.id),
      // ⚠ HARD-FALSE. No recording exists anywhere (BAL-126 / BAL-140 own capture); the
      // indicator does not render. Never wire this to a truthy guess.
      hasRecording: false,
      canReschedule: action.lens === 'client' && canMove,
      canProposeReschedule: action.lens === 'expert' && canMove,
      canCancel,
      // Hard-false / hard-zero — not yet wired; see `CaseConsultationRowView`'s own docblock.
      canInvite: false,
      guestCount: 0,
      scheduledMinutes: Math.round(
        (meeting.scheduledEnd.getTime() - meeting.scheduledStart.getTime()) / 60_000
      ),
      live,
    };
  });

  // Newest LAST — the design reference's "newest last" reading order, so the case reads as a
  // story. Cancelled rows have no ordinal, so they sort by their own occurrence time.
  return rows.sort((a, b) => {
    const aAt = Date.parse(a.startedAtIso ?? a.scheduledStartIso);
    const bAt = Date.parse(b.startedAtIso ?? b.scheduledStartIso);
    return aAt === bAt ? a.meetingId.localeCompare(b.meetingId) : aAt - bAt;
  });
}
