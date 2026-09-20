/**
 * BAL-498 — the calendar's Join affordance window. PURE, client-safe.
 *
 * D2 (decisions-bal-498.md): reuse `CASE_JOIN_WINDOW_MINUTES` — the product's only imminence
 * constant — rather than a second, conflicting "~10 minutes" definition. `withinJoinWindow()`
 * (`@balo/shared/engagements/case-surface.ts`) is NOT exported and has NO end-side bound (it
 * stays true forever after start), and its contract must not be mutated under the case surface.
 * This module composes a NEW, calendar-specific predicate over the same shared constant instead.
 *
 * BAL-513 extends the CLOSE boundary from the scheduled end to `scheduledEnd +
 * MEETING_OVERRUN_GRACE_MINUTES`, and adds a terminal-status gate sourced from
 * `@balo/shared/meetings` — see `calendarJoinAffordanceVisible` below.
 */
import { CASE_JOIN_WINDOW_MINUTES, MEETING_OVERRUN_GRACE_MINUTES } from '@balo/shared/engagements';
import { meetingIsClosedToJoin, type MeetingLifecycleStatus } from '@balo/shared/meetings';
import { insideCaseJoinWindow } from '@/lib/cases/case-join-window';

const MS_PER_MINUTE = 60_000;

/**
 * The instant the calendar's Join affordance CLOSES: the scheduled end plus the product's overrun
 * grace. ONE definition, consumed by `calendarJoinAffordanceVisible` AND by `calendarMeetingTiming`'s
 * `isPast` — BAL-513 D6 puts the two on the SAME boundary, so a card can never be muted while its own
 * Join is still live.
 */
function joinWindowClosesAtMs(scheduledEnd: Date): number {
  return scheduledEnd.getTime() + MEETING_OVERRUN_GRACE_MINUTES * MS_PER_MINUTE;
}

/**
 * Join is offered from `CASE_JOIN_WINDOW_MINUTES` before the scheduled start (inclusive) through
 * `scheduledEnd + MEETING_OVERRUN_GRACE_MINUTES` (EXCLUSIVE) — unless the meeting's status is already
 * terminal, in which case never.
 *
 * ⚠ THE GRACE IS THE POINT (BAL-513 C2). Closing at the scheduled end took the Join control away from
 * an expert whose call ran over and who dropped at end + 5 min: the Daily room is still open and the
 * server's TIME gate (`assertMeetingJoinable` step 3, `MEETING_TOKEN_TTL_AFTER_END_MS`) has no early
 * bound and a 24h upper one, so on THAT axis — and ONLY that axis — the UI was strictly stricter than
 * the system for no benefit.
 *
 * ⚠⚠ THIS DOES NOT MEAN THE SERVER ALWAYS ACCEPTS A JOIN INSIDE THE GRACE (BAL-513 fix round 2, F10
 * — an earlier draft of this comment, and the PR body, both overstated it this way).
 * `assertMeetingJoinable` also refuses on `MEETING_CLOSED_TO_JOIN` (its step 1, ahead of the time
 * check) — the very set this ticket moved into shared, imported below. That gate is REAL: the
 * lifecycle sweep (`apps/api/src/jobs/meeting-lifecycle-sweep.ts`, every minute) can move a meeting to
 * `ended` — and tear down its Daily room — a few minutes after the room empties, well inside this
 * 30-minute window, while this calendar keeps showing a live, joinable card. See the next paragraph
 * for how stale that status can get, and `calendar-shell.tsx`'s focus-refresh effect (F7) for the
 * mitigation — mitigation, not elimination.
 *
 * ⚠ `status` IS A TERMINAL SET, NOT AN ALLOW-LIST, and it is imported — never hand-listed here. A
 * sixth `meeting_status` label must default to OPEN. See `@balo/shared/meetings/closed-to-join.ts`.
 * ⚠ It reflects status AS AT PAGE LOAD, refreshed only when `calendar-shell.tsx`'s focus effect
 * re-runs the Server Component (F7). The 60-second tick alone moves `now` and does NOT refetch, so
 * between two focus events a meeting can still read as joinable after the server has already closed
 * it — this is what the grace window's 30 minutes is wide enough to matter for. Client-side POLLING of
 * meeting status remains a Non-goal; the focus refresh is event-driven, not periodic.
 */
export function calendarJoinAffordanceVisible(
  now: Date,
  scheduledStart: Date,
  scheduledEnd: Date,
  status: MeetingLifecycleStatus
): boolean {
  if (meetingIsClosedToJoin(status)) return false;
  const opensAt = scheduledStart.getTime() - CASE_JOIN_WINDOW_MINUTES * MS_PER_MINUTE;
  const t = now.getTime();
  return t >= opensAt && t < joinWindowClosesAtMs(scheduledEnd);
}

/**
 * Signed minutes to `scheduledStart`, rounded to the nearest minute — negative once the meeting
 * has begun. This is the ONLY helper that may feed the `minutes_to_start` analytics property
 * (`packages/analytics/src/events/calendar.ts`), whose documented contract requires the sign to
 * survive past the start. ⚠ Do NOT floor this at 0 — flooring here silently collapses "joined on
 * the dot" and "joined 12 minutes late" into the same `0` in PostHog (BAL-498 fix round 2, N7).
 */
export function signedMinutesUntilCalendarStart(now: Date, scheduledStart: Date): number {
  return Math.round((scheduledStart.getTime() - now.getTime()) / MS_PER_MINUTE);
}

/**
 * The Join `aria-label`'s timing suffix. Three shapes:
 *   · `"starting in {n} minute(s)"` — before the start;
 *   · `"starting now"` — the BOUNDARY MINUTE only (the rounded signed value is 0, i.e. within
 *     ±30 seconds of the start);
 *   · `"in progress"` — once the meeting has genuinely begun (BAL-513 C2.3 / D10).
 *
 * ⚠ THE DEFECT THIS FIXES: the old implementation floored the signed value at 0, so a screen-reader
 * user 30 minutes into a 60-minute call was told the meeting was "starting now" — and, after the
 * grace extension, would have been told it for 90 minutes.
 *
 * ⚠ `-0` IS LOAD-BEARING IN THE ORDER OF THESE BRANCHES. `Math.round` yields `-0` for a `now` between
 * the start and start + 30 s; `-0 < 0` is FALSE and `-0 === 0` is TRUE, so such an instant correctly
 * falls through to "starting now" rather than to "in progress". Do not reorder or rewrite as
 * `minutes <= 0`.
 *
 * Gender-neutral, present tense (CLAUDE.md "Copy & Microcopy").
 */
export function joinAffordanceTimingLabel(now: Date, scheduledStart: Date): string {
  const minutes = signedMinutesUntilCalendarStart(now, scheduledStart);
  if (minutes < 0) return 'in progress';
  if (minutes === 0) return 'starting now';
  const unit = minutes === 1 ? 'minute' : 'minutes';
  return `starting in ${minutes} ${unit}`;
}

/**
 * The FULL Join `aria-label`. ONE builder, because the Week card and the Agenda row previously each
 * carried their own copy of the template and would have drifted the moment one of them was reworded
 * (BAL-513 D10).
 *
 * ⚠ `timingLabel === null` IS UNREACHABLE AT BOTH CALL SITES — each renders `JoinMeetingButton` only
 * under a `joinVisible` guard, and `calendarMeetingTiming` guarantees a non-null label exactly there.
 * The `?? ''` exists to satisfy the type without a non-null assertion, and the resulting trailing
 * `", "` is deliberately preserved from the pre-BAL-513 shape so nothing about the rendered name moves.
 */
export function joinAffordanceAriaLabel(partyName: string, timingLabel: string | null): string {
  return `Join ${partyName}'s meeting, ${timingLabel ?? ''}`;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** VIEWER-LOCAL calendar days between two instants, floor-to-day on each side — so a 23-hour gap
 *  that crosses local midnight still counts as 1, never a raw elapsed-24h period. Must agree with
 *  `relativeDay`'s day-key comparison (`components/balo/date/relative-day.ts`), or the countdown
 *  and a row's "Tomorrow at …" could disagree about the same meeting. */
function calendarDaysBetween(from: Date, to: Date): number {
  const dayNumber = (date: Date): number =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY;
  return dayNumber(to) - dayNumber(from);
}

/**
 * The Join affordance's countdown label — ALWAYS occupies the slot: "Join now" once the window
 * is open, otherwise how long until the scheduled start. Beside `joinAffordanceTimingLabel` /
 * `joinAffordanceAriaLabel` so a future Up next / calendar consumer can adopt the same ladder
 * without rewording it.
 *
 * ⚠ The hour/day boundary is decided by CALENDAR day, not elapsed minutes — a 23-hour gap that
 * crosses local midnight reads "Join tomorrow", never "Join in 23 hours".
 *
 * ⚠ The "Join now" branch reuses `insideCaseJoinWindow` — the same millisecond-exact predicate
 * `case-nudge.tsx` renders from — rather than rounding `signedMinutesUntilCalendarStart` against
 * `CASE_JOIN_WINDOW_MINUTES`: that rounding let this label read "Join now" for up to ~30s while
 * the render was still showing the inactive countdown. The pre-window minutes below use
 * `Math.ceil`, not `signedMinutesUntilCalendarStart` — that primitive's rounding is pinned to the
 * analytics contract and must not change; this label alone needed a different one.
 */
export function joinCountdownLabel(now: Date, scheduledStart: Date): string {
  if (insideCaseJoinWindow(now, scheduledStart.toISOString())) return 'Join now';
  const minutes = Math.ceil((scheduledStart.getTime() - now.getTime()) / MS_PER_MINUTE);
  if (minutes < 60) return `Join in ${minutes} minutes`;
  const days = calendarDaysBetween(now, scheduledStart);
  if (days <= 0) {
    const hours = Math.round(minutes / 60);
    return `Join in ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return days === 1 ? 'Join tomorrow' : `Join in ${days} days`;
}

/** The three `now`-derived inputs a rendered meeting needs, as ONE composition of the primitives
 *  above — computed by the PARENT so `MeetingBlock` can take primitives and be `React.memo`'d
 *  (BAL-511 D1).
 *
 *  ⚠⚠ `joinTimingLabel` IS `null` WHENEVER JOIN IS NOT VISIBLE, AND THAT IS LOAD-BEARING.
 *  `joinAffordanceTimingLabel` is a function of `now`, so computing it unconditionally would
 *  change every 60 seconds for EVERY meeting on the page ("starting in 180 minutes" → "…179…") —
 *  a prop that changes on every tick, which is precisely the memo this whole change exists to
 *  make possible. Only a meeting inside the join window may carry a label, and such a meeting is
 *  SUPPOSED to re-render each minute so its `aria-label` stays true.
 *
 *  ⚠ RETURNS AN OBJECT, BUT THE CALLER MUST SPREAD ITS FIELDS AS SEPARATE PROPS. Passing the
 *  object itself as one prop would hand `MeetingBlock` a fresh reference every render and defeat
 *  the memo exactly as `now` did.
 *
 *  ⚠ `isPast` AND `joinVisible` SHARE ONE BOUNDARY (BAL-513 D6), AND THAT IS WHAT KEEPS
 *  `JoinMeetingButton`'s "rendered ONLY inside the join window" invariant TRUE. `isPast` used to flip
 *  at `scheduledEnd`; with Join now living 30 minutes past it, the naive change would have produced a
 *  60%-opacity "past" card carrying a live, ping-ringing Join button. Instead a meeting greys the
 *  moment its STATUS says it is over, or when the grace elapses — never while it is still joinable.
 *  The two are exactly complementary after the window opens and are never both `true`; a test pins it.
 */
export function calendarMeetingTiming(
  now: Date,
  scheduledStart: Date,
  scheduledEnd: Date,
  status: MeetingLifecycleStatus
): {
  readonly isPast: boolean;
  readonly joinVisible: boolean;
  readonly joinTimingLabel: string | null;
} {
  const joinVisible = calendarJoinAffordanceVisible(now, scheduledStart, scheduledEnd, status);
  return {
    isPast: meetingIsClosedToJoin(status) || now.getTime() >= joinWindowClosesAtMs(scheduledEnd),
    joinVisible,
    joinTimingLabel: joinVisible ? joinAffordanceTimingLabel(now, scheduledStart) : null,
  };
}
