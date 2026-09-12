import { z } from 'zod';
import {
  CAPTURE_HEALTH_CATEGORIES,
  CAPTURE_HEALTH_DEFAULT_WINDOW_DAYS,
  CAPTURE_HEALTH_MAX_WINDOW_DAYS,
  type CaptureHealthCategory,
} from '@balo/shared/capture-health';

/**
 * BAL-550 (§7.4) — the capture-health page's `?from=`/`?to=`/`?category=` search-param parsing.
 * PURE, no `server-only`, so EVERY entry point can run it — `page.tsx` and
 * `load-capture-health.ts` for the first page, and `loadMoreCaptureHealth` for each keyset page
 * after it.
 *
 * ⚠⚠ {@link parseCaptureHealthWindow} IS THE ONLY PLACE THE READ WINDOW IS BUILT, AND THAT IS A
 * SECURITY PROPERTY, NOT TIDINESS. The bound it applies ({@link CAPTURE_HEALTH_MAX_WINDOW_DAYS})
 * is what keeps `captureHealthRepository`'s three grouped aggregate sub-queries on
 * `meeting_scheduled_start_idx` instead of scanning every meeting Balo has ever held — and the
 * row `LIMIT` does NOT bound those aggregates. The load-more Server Action takes its window
 * from fully client-supplied strings, so it MUST re-run them through this function and use the
 * CLAMPED `from`/`to` it returns; hand-rolling the `+1d` arithmetic there re-opens an unbounded
 * span to any `VIEW_PLATFORM_ADMIN` holder. Its Zod layer only checks the SHAPE of the two
 * strings; the clamp lives here.
 *
 * ⚠ UTC DAY BOUNDARIES, DELIBERATELY. `meetings.scheduled_start` is `timestamptz` and this is a
 * cross-tenant admin lens with no single tenant timezone to anchor on, so the control's own
 * copy says "UTC" rather than silently picking one party's zone.
 */

export interface CaptureHealthWindowView {
  /** `[from, to)` — half-open, matching `captureHealthRepository`'s window contract. */
  from: Date;
  to: Date;
  /** The span, in whole days — what the tiles/control display and what analytics reports. */
  days: number;
  /** `YYYY-MM-DD` strings for the date-range control's two `<input type="date">`s. */
  fromIso: string;
  toIso: string;
  /** True when the requested span was invalid, inverted, or over the cap and silently fell
   *  back — the control renders a note when this is true. */
  fellBack: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` at UTC midnight, or `null` on anything else (including a syntactically valid
 *  but semantically nonsense date like `2026-02-30`, which `Date` would otherwise roll over). */
function parseUtcDateOnly(value: string): Date | null {
  const parts = value.split('-');
  if (parts.length !== 3) return null;
  const [yearStr, monthStr, dayStr] = parts;
  if (yearStr === undefined || monthStr === undefined || dayStr === undefined) return null;
  if (yearStr.length !== 4 || monthStr.length !== 2 || dayStr.length !== 2) return null;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  const rollsOver =
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day;
  if (rollsOver) return null;
  return date;
}

function toIsoDateOnly(date: Date): string {
  const iso = date.toISOString();
  const [datePart] = iso.split('T');
  return datePart ?? iso;
}

function defaultWindow(): { from: Date; to: Date } {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(todayUtc.getTime() + MS_PER_DAY); // half-open: today is IN range
  const from = new Date(todayUtc.getTime() - (CAPTURE_HEALTH_DEFAULT_WINDOW_DAYS - 1) * MS_PER_DAY);
  return { from, to };
}

/**
 * `to` defaults to today (inclusive, so the half-open bound is `today + 1d`); `from` defaults
 * to `to − 30d`. Invalid or inverted input falls back to the default (NEVER a 500); a span over
 * {@link CAPTURE_HEALTH_MAX_WINDOW_DAYS} is clamped from the `from` side (keeping `to` fixed).
 */
export function parseCaptureHealthWindow(input: {
  from?: string;
  to?: string;
}): CaptureHealthWindowView {
  const parsedTo = input.to === undefined ? null : parseUtcDateOnly(input.to);
  const parsedFrom = input.from === undefined ? null : parseUtcDateOnly(input.from);

  if (parsedTo === null || parsedFrom === null) {
    const { from, to } = defaultWindow();
    return buildView(from, to, input.from !== undefined || input.to !== undefined);
  }

  // `to` from the query names the LAST included day — the half-open bound is one day later.
  const toBound = new Date(parsedTo.getTime() + MS_PER_DAY);
  if (parsedFrom.getTime() >= toBound.getTime()) {
    const { from, to } = defaultWindow();
    return buildView(from, to, true);
  }

  const spanDays = Math.round((toBound.getTime() - parsedFrom.getTime()) / MS_PER_DAY);
  if (spanDays > CAPTURE_HEALTH_MAX_WINDOW_DAYS) {
    const clampedFrom = new Date(toBound.getTime() - CAPTURE_HEALTH_MAX_WINDOW_DAYS * MS_PER_DAY);
    return buildView(clampedFrom, toBound, true);
  }

  return buildView(parsedFrom, toBound, false);
}

function buildView(from: Date, to: Date, fellBack: boolean): CaptureHealthWindowView {
  const days = Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
  // The control's `<input type="date">` for `to` names the LAST included day, one day before
  // the half-open bound.
  const lastIncludedDay = new Date(to.getTime() - MS_PER_DAY);
  return {
    from,
    to,
    days,
    fromIso: toIsoDateOnly(from),
    toIso: toIsoDateOnly(lastIncludedDay),
    fellBack,
  };
}

/** `?category=` → a known tile, or `null` (the unfiltered "All recorded consultations" view).
 *  The list is {@link CAPTURE_HEALTH_CATEGORIES}, never a second local copy of it. */
export function parseCaptureHealthCategory(raw: string | undefined): CaptureHealthCategory | null {
  if (raw === undefined) return null;
  return (CAPTURE_HEALTH_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as CaptureHealthCategory)
    : null;
}

/**
 * `?row=` → a meeting id to pin, or `null`.
 *
 * ⚠⚠ THE UUID CHECK IS NOT COSMETIC. `?row=` flows into `captureHealthRepository
 * .findByMeetingId` → `eq(meetings.id, …)`, and Postgres raises `22P02 invalid_text_
 * representation` on a non-UUID rather than returning no rows. `page.tsx` catches every throw
 * from the load into the full-page error state, so `?row=x` would take the WHOLE lens down for
 * whoever opened the link. A malformed id names no meeting, which is precisely the existing
 * "pinned row not found" answer — so it takes that path, not an error one.
 */
export function parseCaptureHealthPinnedRow(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  return z.uuid().safeParse(raw).success ? raw : null;
}
