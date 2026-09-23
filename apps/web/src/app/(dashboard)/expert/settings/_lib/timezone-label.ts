import { extractCityFromTimezone } from '@balo/shared/timezone';

/** 'GMT+11' style short offset for a zone at `at`, or '' if the zone is unknown to Intl. */
export function shortOffset(timezone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    }).formatToParts(at);
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/**
 * Human name for a zone: 'UTC', or the city with its current offset ('Melbourne (GMT+10)').
 * Falls back to the raw IANA id when the zone has no city segment, and to the bare city when
 * Intl cannot resolve an offset.
 */
export function timezoneLabel(timezone: string, at: Date = new Date()): string {
  const city = extractCityFromTimezone(timezone);
  if (!city) return timezone;
  const offset = shortOffset(timezone, at);
  return offset ? `${city} (${offset})` : city;
}

/**
 * Wall-clock time in `timezone` as 'Tue 5:04 AM'. The weekday disambiguates times either
 * side of the date line. Returns '' for a zone Intl cannot resolve.
 */
export function formatWallClock(timezone: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? '';
    return `${part('weekday')} ${part('hour')}:${part('minute')} ${part('dayPeriod')}`;
  } catch {
    return '';
  }
}
