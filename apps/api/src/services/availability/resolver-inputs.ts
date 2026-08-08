import { fromZonedTime } from 'date-fns-tz';
import type { BusyBlock, ResolverConsultation, ResolverRule } from './types.js';

/**
 * REPOSITORY ROWS → RESOLVER INPUTS. The one place `availability_rules`,
 * `consultations` and `availability_overrides` rows are projected onto the shapes the pure
 * resolver accepts.
 *
 * ⚠ EXTRACTED BY BAL-129, NOT INVENTED, AND THE REASON IS CORRECTNESS BEFORE TIDINESS. Two
 * callers now load the same three tables for the same expert and must agree EXACTLY on what
 * they mean:
 *
 *   · `resolve-and-cache.ts` → `resolve()`, which writes the `earliest_available_at` every
 *     expert-facing surface ADVERTISES.
 *   · `window-availability.ts` → `isWindowBookable()`, which decides whether a booking is
 *     ACCEPTED.
 *
 * If those two ever disagreed — about when a time-off block starts, or which columns of a rule
 * matter — the platform would accept a booking for a window it advertises as blocked, or refuse
 * one it advertises as free. One definition makes that unrepresentable. (It is also the shape
 * SonarCloud's cross-file duplication gate flags: ~18 identical lines including `nextDayIso`.)
 *
 * ⚠⚠ SCOPE THE CLAIM PRECISELY, BECAUSE AN EARLIER VERSION OVERSTATED IT. What one definition
 * makes unrepresentable is **ROW-PROJECTION** divergence — the two reads cannot disagree about
 * what a rule row, a consultation row or an override row MEANS. It does NOT make the two reads
 * agree in general, and BAL-129 had to close two further gaps by hand, each in its own place:
 *
 *   · VENDOR FREE/BUSY is a fetch, not a row, so it fell outside this file entirely and each
 *     read defaulted it to `[]` on its own. Now shared as a port — `./vendor-busy.ts`.
 *   · THE CONSULTATION LOAD RANGE is the caller's argument, not a projection: advertise asked
 *     for `[now, horizonEnd]` while accept padded its window on both sides, so a consultation
 *     that ended just before `now` was invisible to one and blocking (once grown by
 *     `bufferAfterMinutes`) in the other. Now shared as `CONSULTATION_LOAD_PAD_MS` below,
 *     applied identically by both.
 *
 * Anyone adding a THIRD resolver input should ask which of those three shapes it is before
 * assuming this file already covers it.
 *
 * PURE: no DB, no clock, no I/O.
 */

/**
 * HOW FAR EITHER READ LOADS CONSULTATIONS **BEYOND** THE RANGE IT CARES ABOUT — shared, so
 * advertise and accept see the SAME neighbouring bookings.
 *
 * ⚠ IT IS NOT SLACK, IT IS CORRECTNESS. `combineBusyIntervals` grows every busy interval by
 * `bufferBeforeMinutes` / `bufferAfterMinutes`, so a consultation ENDING shortly before the
 * range (or BEGINNING shortly after it) can still overlap once padded. Loading only the range
 * itself drops exactly those, which is how the accept path came to be stricter than the
 * advertise path: accept padded, advertise did not, and any expert with
 * `booking_buffer_after_minutes > 0` could be advertised a slot the booking gate then refused
 * with a 409.
 *
 * A whole day is comfortably wider than any sane buffer and keeps both range predicates
 * index-friendly.
 */
export const CONSULTATION_LOAD_PAD_MS = 24 * 60 * 60 * 1000;

/** The `availability_rules` columns the resolver reads. */
export interface AvailabilityRuleRow {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/** The `consultations` columns the resolver reads. Caller filters to `status = 'confirmed'`. */
export interface ConsultationWindowRow {
  startAt: Date;
  endAt: Date;
}

/** The two date-only columns of an `availability_overrides` row, as Drizzle returns them. */
export interface OverrideDateRange {
  /** `'YYYY-MM-DD'` from a Postgres `date` column. */
  startDate: string;
  /** `'YYYY-MM-DD'`, INCLUSIVE. */
  endDate: string;
}

/** Narrow rule rows to exactly the three fields the resolver interprets. */
export function toResolverRules(rows: readonly AvailabilityRuleRow[]): ResolverRule[] {
  return rows.map((r) => ({
    dayOfWeek: r.dayOfWeek,
    startTime: r.startTime,
    endTime: r.endTime,
  }));
}

/** Narrow consultation rows to their window. */
export function toResolverConsultations(
  rows: readonly ConsultationWindowRow[]
): ResolverConsultation[] {
  return rows.map((c) => ({ startAt: c.startAt, endAt: c.endAt }));
}

/**
 * Expand each `[startDate, endDate]` date-only block to an END-INCLUSIVE whole-day UTC
 * interval in the expert's own timezone. `endDate` is inclusive, so the interval runs to
 * midnight of the day AFTER `endDate`. Uses the same `fromZonedTime` approach the resolver
 * uses for rules, so DST is handled identically.
 */
export function expandOverrideBlocks(
  overrides: readonly OverrideDateRange[],
  timezone: string
): BusyBlock[] {
  return overrides.map((o) => ({
    startAt: fromZonedTime(`${o.startDate}T00:00:00`, timezone),
    endAt: fromZonedTime(`${nextDayIso(o.endDate)}T00:00:00`, timezone),
  }));
}

/** `'YYYY-MM-DD'` → the next calendar day `'YYYY-MM-DD'` (UTC arithmetic, tz-agnostic). */
function nextDayIso(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    // Input always comes from a Postgres DATE column (guaranteed YYYY-MM-DD), so this is
    // unreachable. Throw rather than silently returning `iso`: that would yield a zero-length
    // override interval and drop the block, leaving the expert bookable during their own
    // leave — the wrong failure mode for a booking-integrity value.
    throw new Error(`nextDayIso: invalid date string "${iso}" — expected YYYY-MM-DD`);
  }
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
