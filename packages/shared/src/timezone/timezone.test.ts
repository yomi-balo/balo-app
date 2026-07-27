import { describe, it, expect } from 'vitest';
import {
  TIMEZONE_TO_COUNTRY,
  deriveCountryFromTimezone,
  extractCityFromTimezone,
  isValidTimezone,
  getNextSpringForwardGap,
  isWallClockInSpringForwardGap,
} from './index';

describe('TIMEZONE_TO_COUNTRY', () => {
  it('contains entries for all Australian timezones', () => {
    const auTimezones = Object.entries(TIMEZONE_TO_COUNTRY).filter(
      ([, v]) => v.countryCode === 'AU'
    );
    expect(auTimezones.length).toBeGreaterThanOrEqual(9);
    expect(TIMEZONE_TO_COUNTRY['Australia/Sydney']).toEqual({
      country: 'Australia',
      countryCode: 'AU',
    });
    expect(TIMEZONE_TO_COUNTRY['Australia/Melbourne']).toEqual({
      country: 'Australia',
      countryCode: 'AU',
    });
  });

  it('contains entries for major US timezones', () => {
    expect(TIMEZONE_TO_COUNTRY['America/New_York']).toEqual({
      country: 'United States',
      countryCode: 'US',
    });
    expect(TIMEZONE_TO_COUNTRY['America/Los_Angeles']).toEqual({
      country: 'United States',
      countryCode: 'US',
    });
    expect(TIMEZONE_TO_COUNTRY['America/Chicago']).toEqual({
      country: 'United States',
      countryCode: 'US',
    });
    expect(TIMEZONE_TO_COUNTRY['Pacific/Honolulu']).toEqual({
      country: 'United States',
      countryCode: 'US',
    });
  });

  it('contains entries for European countries', () => {
    expect(TIMEZONE_TO_COUNTRY['Europe/London']?.countryCode).toBe('GB');
    expect(TIMEZONE_TO_COUNTRY['Europe/Paris']?.countryCode).toBe('FR');
    expect(TIMEZONE_TO_COUNTRY['Europe/Berlin']?.countryCode).toBe('DE');
    expect(TIMEZONE_TO_COUNTRY['Europe/Rome']?.countryCode).toBe('IT');
    expect(TIMEZONE_TO_COUNTRY['Europe/Madrid']?.countryCode).toBe('ES');
  });

  it('contains entries for Asian countries', () => {
    expect(TIMEZONE_TO_COUNTRY['Asia/Tokyo']?.countryCode).toBe('JP');
    expect(TIMEZONE_TO_COUNTRY['Asia/Seoul']?.countryCode).toBe('KR');
    expect(TIMEZONE_TO_COUNTRY['Asia/Shanghai']?.countryCode).toBe('CN');
    expect(TIMEZONE_TO_COUNTRY['Asia/Singapore']?.countryCode).toBe('SG');
    expect(TIMEZONE_TO_COUNTRY['Asia/Kolkata']?.countryCode).toBe('IN');
    expect(TIMEZONE_TO_COUNTRY['Asia/Dubai']?.countryCode).toBe('AE');
  });

  it('contains entries for South American countries', () => {
    expect(TIMEZONE_TO_COUNTRY['America/Sao_Paulo']?.countryCode).toBe('BR');
    expect(TIMEZONE_TO_COUNTRY['America/Argentina/Buenos_Aires']?.countryCode).toBe('AR');
    expect(TIMEZONE_TO_COUNTRY['America/Mexico_City']?.countryCode).toBe('MX');
  });

  it('contains entries for African countries', () => {
    expect(TIMEZONE_TO_COUNTRY['Africa/Johannesburg']?.countryCode).toBe('ZA');
    expect(TIMEZONE_TO_COUNTRY['Africa/Lagos']?.countryCode).toBe('NG');
    expect(TIMEZONE_TO_COUNTRY['Africa/Cairo']?.countryCode).toBe('EG');
    expect(TIMEZONE_TO_COUNTRY['Africa/Nairobi']?.countryCode).toBe('KE');
  });

  it('all entries have valid 2-letter country codes', () => {
    for (const [tz, data] of Object.entries(TIMEZONE_TO_COUNTRY)) {
      expect(data.countryCode).toHaveLength(2);
      expect(data.countryCode).toMatch(/^[A-Z]{2}$/);
      expect(data.country.length).toBeGreaterThan(0);
      // Ensure timezone key looks like a valid IANA timezone
      expect(tz).toMatch(/^[A-Z][a-zA-Z]+\//);
    }
  });

  it('has at least 100 timezone entries', () => {
    expect(Object.keys(TIMEZONE_TO_COUNTRY).length).toBeGreaterThanOrEqual(100);
  });
});

describe('deriveCountryFromTimezone', () => {
  it('returns country data for known timezones', () => {
    expect(deriveCountryFromTimezone('Australia/Sydney')).toEqual({
      country: 'Australia',
      countryCode: 'AU',
    });
  });

  it('returns null for unknown timezones', () => {
    expect(deriveCountryFromTimezone('Unknown/Timezone')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(deriveCountryFromTimezone('')).toBeNull();
  });

  it('handles legacy timezone aliases', () => {
    expect(deriveCountryFromTimezone('Asia/Calcutta')).toEqual({
      country: 'India',
      countryCode: 'IN',
    });
    expect(deriveCountryFromTimezone('Asia/Saigon')).toEqual({
      country: 'Vietnam',
      countryCode: 'VN',
    });
  });

  it('returns correct data for Canadian timezones', () => {
    expect(deriveCountryFromTimezone('America/Toronto')).toEqual({
      country: 'Canada',
      countryCode: 'CA',
    });
    expect(deriveCountryFromTimezone('America/Vancouver')).toEqual({
      country: 'Canada',
      countryCode: 'CA',
    });
  });

  it('returns correct data for New Zealand', () => {
    expect(deriveCountryFromTimezone('Pacific/Auckland')).toEqual({
      country: 'New Zealand',
      countryCode: 'NZ',
    });
  });
});

describe('extractCityFromTimezone', () => {
  it('extracts city from simple timezone', () => {
    expect(extractCityFromTimezone('Australia/Sydney')).toBe('Sydney');
    expect(extractCityFromTimezone('Europe/London')).toBe('London');
  });

  it('extracts city from nested timezone', () => {
    expect(extractCityFromTimezone('America/Indiana/Indianapolis')).toBe('Indianapolis');
    expect(extractCityFromTimezone('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
  });

  it('replaces underscores with spaces', () => {
    expect(extractCityFromTimezone('America/New_York')).toBe('New York');
    expect(extractCityFromTimezone('Asia/Ho_Chi_Minh')).toBe('Ho Chi Minh');
  });

  it('returns null for UTC', () => {
    expect(extractCityFromTimezone('UTC')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(extractCityFromTimezone(null)).toBeNull();
    expect(extractCityFromTimezone(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractCityFromTimezone('')).toBeNull();
  });
});

describe('isValidTimezone', () => {
  it("accepts 'UTC' even though Intl.supportedValuesOf omits it", () => {
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('accepts a real IANA zone', () => {
    expect(isValidTimezone('Australia/Melbourne')).toBe(true);
  });

  it('rejects an unknown zone', () => {
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('getNextSpringForwardGap', () => {
  // Fixed `from` dates keep these assertions stable regardless of the run date.
  const FROM_JAN_2026 = new Date('2026-01-01T00:00:00Z');

  it('detects the Australia/Melbourne October spring-forward (02:00 → 03:00 on a Sunday)', () => {
    const gap = getNextSpringForwardGap('Australia/Melbourne', FROM_JAN_2026);
    expect(gap).not.toBeNull();
    expect(gap?.gapStartMinutes).toBe(120); // 02:00
    expect(gap?.gapEndMinutes).toBe(180); // 03:00
    expect(gap?.dayOfWeek).toBe(0); // Sunday
    // First Sunday of October 2026 is the 4th.
    expect(gap?.dateISO).toBe('2026-10-04');
  });

  it('detects the America/New_York March spring-forward (02:00 → 03:00 on a Sunday)', () => {
    const gap = getNextSpringForwardGap('America/New_York', FROM_JAN_2026);
    expect(gap).not.toBeNull();
    expect(gap?.gapStartMinutes).toBe(120); // 02:00
    expect(gap?.gapEndMinutes).toBe(180); // 03:00
    expect(gap?.dayOfWeek).toBe(0); // Sunday
    // Second Sunday of March 2026 is the 8th.
    expect(gap?.dateISO).toBe('2026-03-08');
  });

  it('returns null for a timezone without DST (Asia/Singapore)', () => {
    expect(getNextSpringForwardGap('Asia/Singapore', FROM_JAN_2026)).toBeNull();
  });

  it('ignores the fall-back transition and returns the following spring-forward', () => {
    // From April 2026 (after the AU April fall-back) the next gap is still October.
    const gap = getNextSpringForwardGap('Australia/Melbourne', new Date('2026-04-10T00:00:00Z'));
    expect(gap?.dateISO).toBe('2026-10-04');
  });
});

describe('isWallClockInSpringForwardGap', () => {
  const FROM_JAN_2026 = new Date('2026-01-01T00:00:00Z');

  it('flags a Sunday range that overlaps the Melbourne gap', () => {
    // 01:30–04:00 (90–240) on Sunday spans the 02:00–03:00 gap.
    expect(
      isWallClockInSpringForwardGap('Australia/Melbourne', FROM_JAN_2026, {
        dayOfWeek: 0,
        startMinutes: 90,
        endMinutes: 240,
      })
    ).toBe(true);
  });

  it('never flags a 09:00 start (outside every spring-forward gap)', () => {
    expect(
      isWallClockInSpringForwardGap('Australia/Melbourne', FROM_JAN_2026, {
        dayOfWeek: 0,
        startMinutes: 540, // 09:00
        endMinutes: 1020, // 17:00
      })
    ).toBe(false);
  });

  it('does not flag ranges on a different weekday than the transition', () => {
    expect(
      isWallClockInSpringForwardGap('Australia/Melbourne', FROM_JAN_2026, {
        dayOfWeek: 3, // Wednesday — the gap falls on Sunday
        startMinutes: 90,
        endMinutes: 240,
      })
    ).toBe(false);
  });

  it('returns false for a timezone without DST', () => {
    expect(
      isWallClockInSpringForwardGap('Asia/Singapore', FROM_JAN_2026, {
        dayOfWeek: 0,
        startMinutes: 90,
        endMinutes: 240,
      })
    ).toBe(false);
  });
});
