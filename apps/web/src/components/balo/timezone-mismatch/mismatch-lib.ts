import { fromZonedTime } from 'date-fns-tz';
import { extractCityFromTimezone, formatShortUtc, localIsoDate } from '@balo/shared/timezone';
import type { WeeklyRange } from '@/lib/timezone/common-weekly-range';

/** Dispatched on `window` after the gate switches the saved zone, so a mounted Schedule tab
 *  re-reads it rather than writing a stale zone back on its next save. */
export const SCHEDULE_TIMEZONE_CHANGED_EVENT = 'balo:schedule-timezone-changed';

/** The city a zone is spoken of by, or the raw zone id when it has none. */
export function cityOf(timezone: string): string {
  return extractCityFromTimezone(timezone) ?? timezone;
}

/** "9:00 am" — the hour/minute/period parts of `date` in `timezone`, never the locale's own
 *  punctuation, which varies by ICU version. */
export function formatWallTime(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')} ${part('dayPeriod')}`;
}

function formatWeekday(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: timezone, weekday: 'long' }).format(date);
}

function addOneDay(isoDate: string): string {
  const next = new Date(`${isoDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * The instants `range` starts and ends today, in `timezone`. A range that crosses midnight
 * (end earlier than start) ends on the following day.
 */
export function rangeInstants(
  range: WeeklyRange,
  timezone: string,
  now: Date
): { start: Date; end: Date } {
  const today = localIsoDate(now, timezone);
  const start = fromZonedTime(`${today}T${range.startTime}:00`, timezone);
  const endDay = range.endTime <= range.startTime ? addOneDay(today) : today;
  const end = fromZonedTime(`${endDay}T${range.endTime}:00`, timezone);
  return { start, end };
}

/** "9:00 am – 5:00 pm" read in `timezone`. */
function rangeText(start: Date, end: Date, timezone: string): string {
  return `${formatWallTime(start, timezone)} – ${formatWallTime(end, timezone)}`;
}

export function mismatchTitle(
  source: 'detected' | 'manual',
  fromTimezone: string,
  toTimezone: string
): string {
  return source === 'detected'
    ? `You’re in ${cityOf(toTimezone)}, but your hours are set in ${cityOf(fromTimezone)} time`
    : `Switch your hours to ${cityOf(toTimezone)} time?`;
}

export interface MismatchDescriptionInput {
  fromTimezone: string;
  toTimezone: string;
  commonRange: WeeklyRange | null;
  now: Date;
  /** True when `toTimezone` is the zone this device is in, so "here" is accurate. */
  toIsDevice: boolean;
}

/**
 * "It’s 12:00 am here and 9:00 am in Sydney. Your 9:00 am – 5:00 pm Sydney hours are 12:00 am –
 * 8:00 am in London." A manual pick of a zone other than the device's says "in {city}" where
 * the detected form says "here". The second sentence is dropped when there is no usual range.
 */
export function mismatchDescription({
  fromTimezone,
  toTimezone,
  commonRange,
  now,
  toIsDevice,
}: MismatchDescriptionInput): string {
  const fromCity = cityOf(fromTimezone);
  const toCity = cityOf(toTimezone);
  const toDay = formatWeekday(now, toTimezone);
  const fromDay = formatWeekday(now, fromTimezone);
  const fromTime = formatWallTime(now, fromTimezone);
  const fromClock = toDay === fromDay ? fromTime : `${fromTime} ${fromDay}`;
  const where = toIsDevice ? 'here' : `in ${toCity}`;
  const clocks = `It’s ${formatWallTime(now, toTimezone)} ${where} and ${fromClock} in ${fromCity}.`;
  if (commonRange === null) return clocks;

  const { start, end } = rangeInstants(commonRange, fromTimezone, now);
  return `${clocks} Your ${rangeText(start, end, fromTimezone)} ${fromCity} hours are ${rangeText(start, end, toTimezone)} in ${toCity}.`;
}

export function consequenceHeading(toTimezone: string): string {
  return `If you switch to ${cityOf(toTimezone)} time`;
}

export function consequenceBody(
  fromTimezone: string,
  toTimezone: string,
  commonRange: WeeklyRange | null,
  now: Date
): string {
  const toCity = cityOf(toTimezone);
  if (commonRange === null) {
    return `Your hours stay the same, read in ${toCity} time, and the times clients can book move with them.`;
  }
  const { start, end } = rangeInstants(commonRange, fromTimezone, now);
  return `Your hours stay ${rangeText(start, end, fromTimezone)}, read in ${toCity} time, and the times clients can book move with them.`;
}

/** "24 Dec – 2 Jan", or just "24 Dec" for a single-day block. */
function timeOffDates(startDate: string, endDate: string): string {
  const start = formatShortUtc(new Date(`${startDate}T00:00:00Z`));
  if (endDate === startDate) return start;
  const endInstant = new Date(`${endDate}T00:00:00Z`);
  return `${start} – ${formatShortUtc(endInstant)}`;
}

export function timeOffLine(
  nextTimeOff: { startDate: string; endDate: string },
  toTimezone: string
): string {
  return `Your time off (${timeOffDates(nextTimeOff.startDate, nextTimeOff.endDate)}) would be read in ${cityOf(toTimezone)} time too.`;
}

export const BUSY_CALENDAR_LINE = 'Busy times from your connected calendar wouldn’t change.';

export function travellingHint(fromTimezone: string): string {
  return `Travelling but still working with the same clients? Keep ${cityOf(fromTimezone)} hours.`;
}

export function keepLabel(fromTimezone: string): string {
  return `Keep ${cityOf(fromTimezone)} hours`;
}

export function switchLabel(toTimezone: string): string {
  return `Switch to ${cityOf(toTimezone)} time`;
}

export function switchedToast(city: string): string {
  return `Timezone updated. Your hours are now set in ${city} time.`;
}

export const CHECK_CHECKING_COPY = 'Checking your upcoming consultations…';
export const CHECK_NONE_COPY =
  'None of your upcoming consultations would fall outside your new hours.';
export const CHECK_FAILED_COPY =
  'We couldn’t check your upcoming consultations. Nothing that’s booked would move either way.';
export const CHECK_RESCHEDULE_COPY = 'Nothing is moved or cancelled for you.';

export function checkSomeHeadline(count: number): string {
  return `${count} upcoming consultation${count === 1 ? '' : 's'} would fall outside your new hours.`;
}

export function checkSomeStays(count: number): string {
  return `${count === 1 ? 'It would stay' : 'They would stay'} booked at the current time:`;
}
