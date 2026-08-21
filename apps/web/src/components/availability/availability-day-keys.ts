/**
 * BAL-236 — timezone/day-key/grouping/formatting helpers for the availability picker. PURE —
 * no React.
 *
 * ⚠ THE PROTOTYPE BUG THAT MUST NOT BE COPIED. `.claude/design-references/availability-calendar.jsx`
 * does `new Date(dayKey)` on a `'YYYY-MM-DD'` string (L489) and `toISOString().slice(0, 10)` on
 * a local-midnight `Date` (L182-183). Both silently reinterpret a local date as UTC, so every
 * viewer EAST of UTC — the entire primary market — sees the wrong weekday. Neither pattern may
 * appear anywhere in this feature; every function below states which zone (viewer, browser-
 * local/floating, or none) it operates in.
 */
import { formatInTimeZone } from 'date-fns-tz';
import type { AvailabilitySlotDto } from '@balo/shared/availability';
import { extractCityFromTimezone } from '@balo/shared/timezone';

/**
 * A slot's calendar day, in the VIEWER's zone. THE only function that maps an instant to a day.
 * ⚠ NEVER `toISOString().slice(0, 10)` — that is the UTC day, not the viewer's.
 */
export function slotDayKey(startIso: string, viewerTimezone: string): string {
  return formatInTimeZone(new Date(startIso), viewerTimezone, 'yyyy-MM-dd');
}

/**
 * A day key → a FLOATING browser-local midnight `Date`, for `react-day-picker` only.
 * `DayPicker` deals in calendar dates, not instants; this deliberately uses browser-local
 * getters so it round-trips exactly with `calendarDateToDayKey` and never touches UTC.
 */
export function dayKeyToCalendarDate(dayKey: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`dayKeyToCalendarDate: invalid day key "${dayKey}"`);
  }
  return new Date(y, m - 1, d);
}

/** The inverse of `dayKeyToCalendarDate`. Browser-local getters, string-built — never
 *  `toISOString`. */
export function calendarDateToDayKey(date: Date): string {
  const yyyy = date.getFullYear().toString().padStart(4, '0');
  const mm = (date.getMonth() + 1).toString().padStart(2, '0');
  const dd = date.getDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Today, in the VIEWER's zone. */
export function todayDayKey(viewerTimezone: string, now: Date = new Date()): string {
  return formatInTimeZone(now, viewerTimezone, 'yyyy-MM-dd');
}

/** Group slots by viewer-zone day, preserving ascending order within each day. Assumes
 *  `slots` already arrives ascending by `start` (the wire contract). */
export function groupSlotsByDay(
  slots: readonly AvailabilitySlotDto[],
  viewerTimezone: string
): Map<string, AvailabilitySlotDto[]> {
  const byDay = new Map<string, AvailabilitySlotDto[]>();
  for (const slot of slots) {
    const key = slotDayKey(slot.start, viewerTimezone);
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.push(slot);
    } else {
      byDay.set(key, [slot]);
    }
  }
  return byDay;
}

/** `'2:15 PM'` in the viewer's zone. */
export function formatSlotTime(iso: string, viewerTimezone: string): string {
  return formatInTimeZone(new Date(iso), viewerTimezone, 'h:mm a');
}

/** `'Wed'` in the viewer's zone — the crossing marker for a slot that runs past midnight. */
export function formatWeekdayShort(iso: string, viewerTimezone: string): string {
  return formatInTimeZone(new Date(iso), viewerTimezone, 'EEE');
}

/**
 * True when a slot's own end lands on a later viewer-zone calendar day than its start.
 *
 * ⚠ D10 REQUIRES THIS TO BE VISIBLE. Cross-midnight intervals group under the interval's START
 * day, "labelled to show the crossing" — without a label a row reading `11:45 PM · up to 60m`
 * silently means "and it finishes tomorrow". The end used is the slot's OWN `maxDuration`, so
 * the marker appears in `preview` mode too, where there is no duration step to reveal it later.
 */
export function slotCrossesMidnight(
  slot: Pick<AvailabilitySlotDto, 'start' | 'end'>,
  viewerTimezone: string
): boolean {
  return slotDayKey(slot.start, viewerTimezone) !== slotDayKey(slot.end, viewerTimezone);
}

/** `'Wednesday 26 August'` from a day key. Floating date — no zone involved, by design. */
export function formatDayHeading(dayKey: string): string {
  const date = dayKeyToCalendarDate(dayKey);
  return date.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** The timezone chip label, e.g. `'Times in Melbourne (AEST)'`. Falls back to the raw IANA
 *  string when no city can be extracted (e.g. `'UTC'`). */
export function formatTimezoneLabel(viewerTimezone: string, now: Date = new Date()): string {
  const city = extractCityFromTimezone(viewerTimezone);
  const abbreviation = formatInTimeZone(now, viewerTimezone, 'zzz');
  const place = city ?? viewerTimezone;
  return `Times in ${place} (${abbreviation})`;
}
