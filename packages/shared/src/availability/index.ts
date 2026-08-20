/**
 * BAL-236 — shared availability/slot-picker product constants and wire types.
 *
 * ⚠ ZERO IMPORTS, DELIBERATELY. A relative re-export elsewhere in `packages/shared` that
 * carries a `.js` extension breaks Turbopack's raw-TS resolution (a real, previously-hit
 * footgun); this module sidesteps the whole class of bug by importing nothing at all, so it
 * is always safe to pull into the browser bundle via `@balo/shared/availability`.
 *
 * `platform_config` is not on `main` (BAL-398 / PR #180 unmerged), so every number below is a
 * typed constant rather than a DB-backed config row. They are the natural first migration
 * once that table lands (see the plan's Open Question 4).
 */

/** Grid granularity, in minutes. THE one definition of 15 in this repo (D4). */
export const SLOT_STEP_MINUTES = 15;

/**
 * The durations a Case consultation may be booked for (D5). A deliberate product cap for
 * per-minute Case consultations — NOT `MAX_MEETING_MINUTES = 480`, which bounds the booking
 * gate, not this picker.
 */
export const SLOT_DURATION_LADDER = [15, 30, 45, 60] as const;
export type SlotDurationMinutes = (typeof SLOT_DURATION_LADDER)[number];

export const MIN_SLOT_MINUTES = 15;
export const MAX_SLOT_MINUTES = 60;

/** Default look-ahead, in every mode. */
export const DEFAULT_AVAILABILITY_WINDOW_DAYS = 14;

/**
 * Hard server-side rejection bound on `days`, AND the width always computed and cached (§3.4).
 * The two are deliberately ONE number: computing a wider grid than any caller can ask for
 * publishes more of a named individual's calendar complement than any consumer renders, and
 * serving a narrower one than `days` claims makes `windowEnd` a lie.
 *
 * ⚠ 14 IS THE ADVERTISE HORIZON, NOT A NEW NUMBER (apiroc skill, Constraint 6: "Cap
 * `freeBusy.get` to the horizon of the caller's question — do not invent a third"). This repo
 * has exactly TWO calendar horizons: the 14-day advertise horizon (`RESOLVER_HORIZON_DAYS` in
 * `resolve-and-cache.ts`) and the 365-day booking horizon (`MAX_BOOKING_HORIZON_DAYS`). This is
 * the first. An earlier draft of BAL-236 used 60 — a third horizon — and the security phase
 * flagged it as over-collection: nothing shipped renders 60 days. BAL-400 is where a 60-day
 * public picker would land, and widening this belongs in that ticket TOGETHER WITH an ADR-1021 /
 * Constraint 6 amendment. Do not widen it by drift.
 */
export const MAX_AVAILABILITY_WINDOW_DAYS = 14;

/** Response-cache TTL (seconds). Lives HERE, not in the route, so the lead-guard invariant
 *  below cannot drift from it. */
export const AVAILABILITY_CACHE_TTL_SECONDS = 60;

/**
 * §1.3 — cache-staleness guard band added to the expert's minimum notice.
 *
 * ⚠ INVARIANT: `AVAILABILITY_LEAD_GUARD_MINUTES * 60 >= AVAILABILITY_CACHE_TTL_SECONDS * 2 + 60`.
 *
 * TWO cache layers sit in series, not one: the Redis response cache (`AVAILABILITY_CACHE_TTL_SECONDS`)
 * AND the browser's, because the route sends `Cache-Control: public, max-age=60` and the hook
 * deliberately does not opt out of it. Worst-case machine-side staleness is therefore
 * `TTL * 2` = 120s, and the `+ 60` is one further minute for network latency, clock skew and the
 * user's think-time between seeing a slot and clicking it. An earlier draft sized this against
 * ONE layer (guard = 2) and the measured margin came out at exactly 120s — zero headroom.
 * Break this and the picker advertises slots the booking gate refuses seconds later.
 */
export const AVAILABILITY_LEAD_GUARD_MINUTES = 3;

export type AvailabilityStatus = 'ok' | 'not_configured' | 'no_slots' | 'unavailable';

export interface AvailabilitySlotDto {
  /** UTC ISO-8601. */
  start: string;
  /** UTC ISO-8601 = `start` + `maxDuration` minutes. */
  end: string;
  /** Contiguous free minutes from `start`. Always ∈ SLOT_DURATION_LADDER. */
  maxDuration: number;
}

export interface ExpertAvailabilityResponse {
  expertProfileId: string;
  status: 'ok' | 'not_configured' | 'no_slots';
  /** IANA zone the expert authored their hours in. */
  expertTimezone: string;
  /** UTC ISO — when the underlying computation ran (may be up to the cache TTL old). */
  generatedAt: string;
  /** UTC ISO — far edge of the returned window. */
  windowEnd: string;
  /** The CLAMPED look-ahead actually served (never the raw query value). */
  days: number;
  slots: AvailabilitySlotDto[];
}

export interface ExpertAvailabilityUnavailableResponse {
  status: 'unavailable';
  retryAfterSeconds: number;
}
