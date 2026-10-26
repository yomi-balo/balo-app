/**
 * business-days — Monday-to-Friday day arithmetic on UTC dates.
 *
 * Weekends are the only non-business days: there is no holiday calendar. A date's weekday is
 * read from its UTC calendar day, and the time of day is preserved by `addBusinessDays`.
 */

const MS_PER_DAY = 86_400_000;

function isUtcWeekday(date: Date): boolean {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/**
 * `date` itself on a weekday; on a weekend, the Friday before it at the same UTC time of day.
 */
export function lastWeekdayOnOrBefore(date: Date): Date {
  const day = date.getUTCDay();
  if (day === 6) return addUtcDays(date, -1);
  if (day === 0) return addUtcDays(date, -2);
  return date;
}

/**
 * Moves `from` by `days` business days (negative moves back), keeping the UTC time of day.
 * Each step lands on the next weekday in that direction, so a weekend start is first
 * counted from the nearest weekday boundary in the direction of travel.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const step = days < 0 ? -1 : 1;
  let remaining = Math.abs(days);
  let cursor = new Date(from.getTime());
  while (remaining > 0) {
    cursor = addUtcDays(cursor, step);
    if (isUtcWeekday(cursor)) remaining -= 1;
  }
  return cursor;
}

/**
 * The count of weekday UTC dates in the half-open range `(from, to]`. Zero when `to` is on or
 * before `from`'s calendar day.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  const startDay = Math.floor(from.getTime() / MS_PER_DAY);
  const endDay = Math.floor(to.getTime() / MS_PER_DAY);
  let count = 0;
  for (let day = startDay + 1; day <= endDay; day += 1) {
    if (isUtcWeekday(new Date(day * MS_PER_DAY))) count += 1;
  }
  return count;
}
