const isoDateFormatters = new Map<string, Intl.DateTimeFormat>();

function isoDateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = isoDateFormatters.get(timeZone);
  if (formatter === undefined) {
    // `en-CA` formats a date as YYYY-MM-DD.
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    isoDateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The calendar date (`YYYY-MM-DD`) that `now` falls on in `timeZone`. A missing or
 * unrecognised zone falls back to UTC, so the result is always a valid date.
 */
export function localIsoDate(now: Date, timeZone: string | null | undefined): string {
  if (timeZone) {
    try {
      return isoDateFormatter(timeZone).format(now);
    } catch {
      // `Intl.DateTimeFormat` throws a RangeError for an unrecognised zone.
    }
  }
  return isoDateFormatter('UTC').format(now);
}
