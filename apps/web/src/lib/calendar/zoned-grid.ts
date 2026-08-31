/**
 * BAL-498 — DST-safe grid math for the expert calendar's Week view. PURE — no React, client-safe.
 *
 * ⚠ THE GRID MODEL IS WALL-CLOCK, NEVER ELAPSED-MILLISECONDS. A block's vertical position and
 * height are computed from the WALL-CLOCK reading of each endpoint, independently, through
 * `Intl` (via `date-fns-tz`'s `formatInTimeZone`). The elapsed-milliseconds difference between
 * two instants is NEVER used for layout — that is exactly the regression this module exists to
 * prevent (a 60-real-minute meeting that spans the spring-forward gap must render 120 wall-clock
 * minutes tall, matching what the expert's own clock says, not 60).
 *
 * ⚠ Day-key arithmetic (`addDaysToDayKey`, `weekStartDayKey`) runs entirely over `Date.UTC` — a
 * fixed-offset arena no DST transition can perturb — and deliberately does NOT route through
 * `dayKeyToCalendarDate` (that helper exists to feed `react-day-picker`, which needs a browser-
 * local `Date`; a browser-local `Date` introduces a zone that has no business in "what is the
 * day after 2026-04-05").
 */
import { formatInTimeZone } from 'date-fns-tz';
// `zonedDayKey` is the ONE of the four that is also USED here (`zonedMeetingSpan`, below), so it
// needs a local binding as well as a re-export.
import { slotDayKey as zonedDayKey } from '@/components/availability/availability-day-keys';

/**
 * The module's zone-aware vocabulary, re-exported under this module's names so every calendar
 * consumer imports "one grid module" rather than reaching into `availability/` for half of it.
 *
 * `export ... from` rather than import-then-export (round 6, items 7-9): three of these four are
 * PURE pass-throughs this file never calls, and a redundant local binding is what SonarCloud
 * flags. ⚠ `formatZonedTimeRange` further down is a DIFFERENT symbol defined in this file — it
 * merely shares a prefix with `formatZonedTime`, so do not "de-duplicate" them.
 */
export {
  slotDayKey as zonedDayKey,
  todayDayKey,
  formatSlotTime as formatZonedTime,
  formatTimezoneLabel,
} from '@/components/availability/availability-day-keys';

/** Minutes in a day — the fixed-offset arena day keys are diffed within. */
const MINUTES_PER_DAY = 1440;

/**
 * Minutes since local midnight for an instant, in a named zone. DST-proof: it reads the wall
 * clock through `Intl` and does no arithmetic on instants.
 */
export function zonedMinutesOfDay(iso: string, timeZone: string): number {
  const formatted = formatInTimeZone(new Date(iso), timeZone, 'HH:mm');
  const [hours, minutes] = formatted.split(':').map(Number);
  if (hours === undefined || minutes === undefined) {
    throw new Error(`zonedMinutesOfDay: unexpected formatted time "${formatted}"`);
  }
  return hours * 60 + minutes;
}

/**
 * `true` only for a day key that is both well-formed AND a real calendar date — e.g.
 * `'9999-99-99'` matches the shape a caller might Zod/regex-validate but is not a real date;
 * `Date.UTC` silently NORMALISES the overflow (month 99 rolls forward), so a shape-only check
 * lets an out-of-range value reach an `Invalid Date` several calls downstream (security-bal-498.md
 * LOW finding — an unvalidated `?week=` reaching the Drizzle query as an Invalid Date).
 */
export function isValidDayKey(dayKey: string): boolean {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Calendar arithmetic on a day KEY (`'yyyy-MM-dd'`), in a fixed-offset arena (`Date.UTC`). No
 * zone can perturb it, and no DST transition exists in UTC.
 */
export function addDaysToDayKey(dayKey: string, delta: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new Error(`addDaysToDayKey: invalid day key "${dayKey}"`);
  }
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  const yyyy = shifted.getUTCFullYear().toString().padStart(4, '0');
  const mm = (shifted.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = shifted.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** The Monday-anchored week start for a day key. Pure string in / string out. */
export function weekStartDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new Error(`weekStartDayKey: invalid day key "${dayKey}"`);
  }
  // getUTCDay(): 0 = Sunday .. 6 = Saturday. Monday-anchored offset back to Monday.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const offsetFromMonday = weekday === 0 ? 6 : weekday - 1;
  return addDaysToDayKey(dayKey, -offsetFromMonday);
}

/** `'2:30 – 3:00 PM'`. Both endpoints formatted independently in the zone. */
export function formatZonedTimeRange(startIso: string, endIso: string, timeZone: string): string {
  const start = formatInTimeZone(new Date(startIso), timeZone, 'h:mm');
  const startMeridiem = formatInTimeZone(new Date(startIso), timeZone, 'a');
  const end = formatInTimeZone(new Date(endIso), timeZone, 'h:mm a');
  const endMeridiem = formatInTimeZone(new Date(endIso), timeZone, 'a');
  if (startMeridiem === endMeridiem) {
    return `${start} – ${end}`;
  }
  return `${start} ${startMeridiem} – ${end}`;
}

/**
 * A meeting's position within a single day column, clipped at local midnight when it runs
 * past it (the caller renders the overflow as a second fragment in the next column).
 */
export interface ZonedMeetingSpan {
  readonly startMinutes: number;
  /** Clipped to `1440` (local midnight) when the meeting continues into the next day. */
  readonly endMinutes: number;
  readonly crossesMidnight: boolean;
}

/** Computes {@link ZonedMeetingSpan} for the day column the meeting STARTS in. */
export function zonedMeetingSpan(
  startIso: string,
  endIso: string,
  timeZone: string
): ZonedMeetingSpan {
  const startDay = zonedDayKey(startIso, timeZone);
  const endDay = zonedDayKey(endIso, timeZone);
  const startMinutes = zonedMinutesOfDay(startIso, timeZone);
  const crossesMidnight = startDay !== endDay;
  const endMinutes = crossesMidnight ? MINUTES_PER_DAY : zonedMinutesOfDay(endIso, timeZone);
  return { startMinutes, endMinutes, crossesMidnight };
}

/**
 * `{ weekday: 'Mon', dayNumber: 24 }` from a floating day key. Parsed via `Date.UTC` (never the
 * host's local zone) — the day key already IS the calendar date, in whichever zone produced it.
 */
export function formatDayColumnHeading(dayKey: string): { weekday: string; dayNumber: number } {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new Error(`formatDayColumnHeading: invalid day key "${dayKey}"`);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = new Intl.DateTimeFormat('en-AU', { weekday: 'short', timeZone: 'UTC' }).format(
    date
  );
  return { weekday, dayNumber: day };
}
