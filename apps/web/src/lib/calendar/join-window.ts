/**
 * BAL-498 — the calendar's Join affordance window. PURE, client-safe.
 *
 * D2 (decisions-bal-498.md): reuse `CASE_JOIN_WINDOW_MINUTES` — the product's only imminence
 * constant — rather than a second, conflicting "~10 minutes" definition. `withinJoinWindow()`
 * (`@balo/shared/engagements/case-surface.ts`) is NOT exported and has NO end-side bound (it
 * stays true forever after start), and its contract must not be mutated under the case surface.
 * This module composes a NEW, calendar-specific predicate over the same shared constant instead.
 */
import { CASE_JOIN_WINDOW_MINUTES } from '@balo/shared/engagements';

const MS_PER_MINUTE = 60_000;

/**
 * Join is offered from `CASE_JOIN_WINDOW_MINUTES` before the scheduled start (inclusive at the
 * boundary) through the scheduled END (exclusive). Both boundaries are meant to be driven by the
 * same 60-second tick that drives the calendar's now-line, so Join and the "live" chrome move
 * together.
 */
export function calendarJoinAffordanceVisible(
  now: Date,
  scheduledStart: Date,
  scheduledEnd: Date
): boolean {
  const opensAt = scheduledStart.getTime() - CASE_JOIN_WINDOW_MINUTES * MS_PER_MINUTE;
  const t = now.getTime();
  return t >= opensAt && t < scheduledEnd.getTime();
}

/**
 * Signed minutes to `scheduledStart`, rounded to the nearest minute — negative once the meeting
 * has begun. This is the ONLY helper that may feed the `minutes_to_start` analytics property
 * (`packages/analytics/src/events/calendar.ts`), whose documented contract requires the sign to
 * survive past the start. ⚠ Do NOT floor this at 0 — that is what `minutesUntilCalendarStart`
 * (below) is for, and flooring here silently collapses "joined on the dot" and "joined 12 minutes
 * late" into the same `0` in PostHog (BAL-498 fix round 2, N7).
 */
export function signedMinutesUntilCalendarStart(now: Date, scheduledStart: Date): number {
  return Math.round((scheduledStart.getTime() - now.getTime()) / MS_PER_MINUTE);
}

/**
 * Minutes remaining until `scheduledStart`, floored at 0 once the meeting has started. Drives the
 * Join `aria-label` ONLY — design requires "starting now" **or** "in {n} minutes", never a
 * hard-coded "starting now" for the whole 15-minute window (a screen-reader user 12 minutes early
 * was told a factually wrong "starting now"). Never feed this into analytics — see
 * `signedMinutesUntilCalendarStart` above.
 */
export function minutesUntilCalendarStart(now: Date, scheduledStart: Date): number {
  return Math.max(0, signedMinutesUntilCalendarStart(now, scheduledStart));
}

/** `"starting now"` or `"in {n} minutes"` — the exact Join `aria-label` suffix the design specs. */
export function joinAffordanceTimingLabel(now: Date, scheduledStart: Date): string {
  const minutes = minutesUntilCalendarStart(now, scheduledStart);
  if (minutes === 0) return 'starting now';
  const unit = minutes === 1 ? 'minute' : 'minutes';
  return `starting in ${minutes} ${unit}`;
}
