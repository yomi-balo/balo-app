import { describe, it, expect } from 'vitest';
import { TIMEZONE_TO_COUNTRY, deriveCountryFromTimezone, extractCityFromTimezone } from './index';

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
