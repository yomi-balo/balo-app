import type { MeetingLifecycleStatus } from './lifecycle';

/**
 * BAL-616 — THE ONE DEFINITION OF "an upcoming call on a conversation context".
 *
 * Both apps read it, so the page and both servers count the same calls:
 *   · `apps/web` — the request page's upcoming-calls list, the header's next-call pick and the
 *     booking action's cap pre-check (`lib/project-request/conversation-view-types.ts`);
 *   · `apps/api` — the booking gate's cap (`services/meetings/authorize-meeting-booking.ts`).
 * A second copy would let the page offer a booking that a server refuses, or the reverse.
 *
 * A meeting is upcoming when it has NOT ended and EITHER:
 *   · it is LIVE (`in_progress` / `waiting_for_participants`). A call that runs past its
 *     scheduled end stays `in_progress` (`MEETING_TRANSITIONS` only lets it move to `ended`), so
 *     the clock must not retire it while the parties are still in the room. Somebody waiting in
 *     the lobby counts the same way;
 *   · OR its scheduled window has not finished (`scheduledEnd > nowMs`). This is what retires a
 *     `scheduled` meeting that nobody ever joined.
 *
 * ⚠ `cancelled` IS NOT JUDGED HERE, AND THE CALLER'S READ MUST EXCLUDE IT. Every caller feeds
 * this rows that already filter `status <> 'cancelled'`
 * (`meetingsRepository.listActiveMeetingsForContexts`). A cancelled meeting whose window is still
 * ahead would otherwise count as upcoming.
 *
 * ⚠ `nowMs` IS A PARAMETER, NEVER `Date.now()` READ INSIDE. It keeps the rule pure and testable,
 * and keeps a clock out of a subpath that client components import.
 *
 * ⚠ STRUCTURAL INPUT, NOT `@balo/db`'s ROW TYPE. `@balo/db`'s `ContextMeetingSummary` and any
 * api row with these two fields are assignable to {@link UpcomingContextMeetingLike}, and
 * nothing here value-imports `@balo/db` (the client-bundle footgun).
 *
 * PURE. Reads no clock, performs no I/O.
 */

/** What the rule reads from a meeting — nothing else. */
export interface UpcomingContextMeetingLike {
  readonly status: MeetingLifecycleStatus;
  readonly scheduledEnd: Date;
}

/**
 * The two meeting contexts a conversation thread's calls are booked under: `request_interaction`
 * before kickoff (the relationship) and `project_call` from kickoff on (the engagement). THE one
 * tuple every copy of this union derives from.
 */
export const UPCOMING_CALL_CONTEXT_TYPES = ['request_interaction', 'project_call'] as const;
export type UpcomingCallContextType = (typeof UPCOMING_CALL_CONTEXT_TYPES)[number];

/**
 * How many upcoming calls one conversation thread may hold at once. The api counts the context
 * being booked (`request_interaction` before kickoff, `project_call` after), and a meeting
 * carrying both contexts is counted once. A call booked in the window between kickoff's
 * re-anchor and the booking path's context read stays on `request_interaction` only, so a
 * `project_call` cap does not count it; it still shows on the request page and in Up next.
 * Accepted, low impact.
 *
 * A live (`in_progress` / `waiting_for_participants`) meeting holds its slot until the lifecycle
 * sweep ends it.
 *
 * ⚠ CHECK-THEN-ACT. The web booking action and the api booking gate both count before the
 * booking is written, so two concurrent bookings can both pass at 2 and land a 4th call. The
 * cap is a product limit, not a safety property.
 */
export const UPCOMING_CALL_CAP = 3;

/** A meeting whose parties are in the room right now, so its scheduled window says nothing. */
function isLiveMeetingStatus(status: MeetingLifecycleStatus): boolean {
  return status === 'in_progress' || status === 'waiting_for_participants';
}

/** `true` when this meeting is an upcoming call at `nowMs`. See the module docblock. */
export function isUpcomingContextMeeting(m: UpcomingContextMeetingLike, nowMs: number): boolean {
  return (
    m.status !== 'ended' && (isLiveMeetingStatus(m.status) || m.scheduledEnd.getTime() > nowMs)
  );
}
