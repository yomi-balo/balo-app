/**
 * BOOKING BOUNDS (BAL-129 / D10) — the outer envelope of ONE bookable meeting window.
 *
 * ⚠⚠ WHAT THESE CONSTANTS DO AND DO NOT BOUND — READ THIS BEFORE RELYING ON THEM. An earlier
 * version of this block claimed they "close hostile booking on a calendar the actor
 * legitimately reaches". THAT WAS FALSE, and it was the stated justification for building
 * nothing else, which is why it is corrected here rather than quietly reworded.
 *
 * These are PER-WINDOW caps. They bound the SHAPE of a single proposed booking — its
 * duration and how far ahead it sits — and nothing more. They say nothing about how MANY
 * bookings an actor may place, and a caller enforcing only these would accept ~1,095
 * consecutive 8-hour windows and fill a year of any reachable expert's calendar, plus any
 * number of MUTUALLY OVERLAPPING windows, with every request passing authorization.
 *
 * THE AGGREGATE BOUND IS SOMEWHERE ELSE, AND IT IS TWO THINGS (BAL-129 §2):
 *   1. AVAILABILITY VALIDATION — `apps/api`'s `isWindowBookable`
 *      (`services/availability/resolver.ts`, wired through
 *      `services/availability/window-availability.ts`) requires the proposed window to lie
 *      wholly inside availability the expert PUBLISHED and to be free of every already-booked
 *      consultation. That is the load-bearing one: a caller can only consume slots the expert
 *      actually offered, each booking removes one, and overlaps are refused.
 *   2. RATE LIMITING — `POST /meetings` is limited per-user AND per-(user, expert) pair, and
 *      FAILS CLOSED on a Redis error because it is a write path.
 *
 * The reason the aggregate bound matters at all is unchanged and still true: `project_kickoff`
 * and `project_discovery` carry NO CREDIT HOLD — nothing is reserved, nothing is charged, and
 * `openSession`'s money gates never run — so for those contexts there is no financial cost to
 * booking, and calendar consumption is the only thing anything bounds. BAL-129's tenancy gate
 * closes booking on a STRANGER'S calendar; (1) and (2) close volume on a calendar the actor
 * legitimately reaches; these constants only keep any ONE window sane.
 *
 * PRODUCT-TUNABLE. These are product numbers, not physical limits. They are typed consts
 * rather than hosted config because `platform_config` is NOT on main (BAL-398 / PR #180 is
 * unmerged); when it lands, this is a natural early migration.
 *
 * PURE and dependency-free (the `@balo/shared/engagements` precedent), and the validator
 * below reads NO CLOCK — `now` is injected — so a caller can never accidentally freeze
 * "the present" at module-import time. See §6.2 of BAL-129's plan for why the
 * clock-dependent checks deliberately do NOT live in a Zod refinement.
 */

/**
 * Floor. Mirrors the 15-minute settlement floor — a 1-minute booking must not be
 * constructible. ⚠ There is no `MIN_SESSION_MINUTES` constant in `@balo/shared/pricing`
 * today (verified); the floor is a product rule stated in tickets. If BAL-412 ever
 * encodes it, THESE TWO MUST NOT DRIFT — import one from the other.
 */
export const MIN_MEETING_MINUTES = 15;

/**
 * Ceiling on a single scheduled window (8h).
 * ⚠ DELIBERATELY WIDER THAN `MAX_SESSION_MINUTES = 240`. They bound different things:
 * that one caps a CONNECTED session's duration (the reaper's abandoned-call stop), this
 * one caps a SCHEDULED window. Do not unify them.
 */
export const MAX_MEETING_MINUTES = 480;

/** How far ahead a booking may be placed. */
export const MAX_BOOKING_HORIZON_DAYS = 365;

/** Why a proposed `[start, end)` is not bookable. One violation, the first that holds. */
export type BookingWindowViolation =
  /**
   * At least one of `start` / `end` / `now` is not a real instant — an Invalid Date, or one
   * of the values Postgres can represent and JavaScript cannot (`'infinity'`, pg's min/max
   * timestamps), all of which parse to `NaN`. Reported FIRST because every comparison below
   * it is NaN-blind: `NaN <= NaN` is `false`, so an unguarded Invalid Date would fall
   * through every rule and be reported as VALID.
   */
  | 'invalid_instant'
  | 'start_not_future'
  | 'end_before_start'
  | 'duration_below_minimum'
  | 'duration_above_maximum'
  | 'start_beyond_horizon';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * PURE. `now` is INJECTED — this module reads no clock. `null` ⇒ the window is valid.
 *
 * THE ORDER IS PART OF THE CONTRACT and is pinned by `bounds.test.ts`: an inverted window
 * is reported as `end_before_start` even when it is also in the past, so a caller sees the
 * same code for the same defect every time rather than one that depends on how many rules
 * a single bad window happens to break.
 *
 * Boundaries are INCLUSIVE of the legal value: exactly `MIN_MEETING_MINUTES`, exactly
 * `MAX_MEETING_MINUTES`, and a start exactly `MAX_BOOKING_HORIZON_DAYS` out are all valid.
 * `start === now` is NOT — a booking must be in the future.
 *
 * ⚠ IT FAILS CLOSED ON A NON-FINITE INSTANT, AND THAT GUARD MUST STAY FIRST. Every
 * comparison below is NaN-blind (`NaN <= NaN` is `false`, `NaN < 15` is `false`), so without
 * it `validateBookingWindow(new Date('x'), …)` would fall through all five rules and return
 * `null` — i.e. report a garbage window as VALID. Not reachable through `POST /meetings`
 * today, whose Zod boundary uses a strict `.datetime()` string — but this is EXPORTED PUBLIC
 * API in `@balo/shared/meetings`, and BAL-409/BAL-410/BAL-411 will call it from routes that
 * may parse with `z.coerce.date()`, where an unparseable input becomes an Invalid Date rather
 * than a Zod issue. Pinned by `bounds.test.ts`.
 */
export function validateBookingWindow(
  start: Date,
  end: Date,
  now: Date
): BookingWindowViolation | null {
  const startMs = start.getTime();
  const endMs = end.getTime();
  const nowMs = now.getTime();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(nowMs)) {
    return 'invalid_instant';
  }
  if (endMs <= startMs) {
    return 'end_before_start';
  }
  if (startMs <= nowMs) {
    return 'start_not_future';
  }

  const durationMinutes = (endMs - startMs) / MS_PER_MINUTE;
  if (durationMinutes < MIN_MEETING_MINUTES) {
    return 'duration_below_minimum';
  }
  if (durationMinutes > MAX_MEETING_MINUTES) {
    return 'duration_above_maximum';
  }
  if (startMs > nowMs + MAX_BOOKING_HORIZON_DAYS * MS_PER_DAY) {
    return 'start_beyond_horizon';
  }
  return null;
}
