import { describe, it, expect } from 'vitest';
import { deriveCountryFromTimezone, extractCityFromTimezone } from '@balo/shared/timezone';

describe('deriveCountryFromTimezone', () => {
  it('returns country data for a known timezone', () => {
    expect(deriveCountryFromTimezone('Australia/Sydney')).toEqual({
      country: 'Australia',
      countryCode: 'AU',
    });
  });

  it('returns country data for US timezone', () => {
    expect(deriveCountryFromTimezone('America/New_York')).toEqual({
      country: 'United States',
      countryCode: 'US',
    });
  });

  it('returns country data for European timezone', () => {
    expect(deriveCountryFromTimezone('Europe/London')).toEqual({
      country: 'United Kingdom',
      countryCode: 'GB',
    });
  });

  it('returns country data for Asian timezone', () => {
    expect(deriveCountryFromTimezone('Asia/Tokyo')).toEqual({
      country: 'Japan',
      countryCode: 'JP',
    });
  });

  it('returns null for an unknown timezone', () => {
    expect(deriveCountryFromTimezone('Unknown/Place')).toBeNull();
  });

  it('returns null for UTC', () => {
    expect(deriveCountryFromTimezone('UTC')).toBeNull();
  });
});

describe('extractCityFromTimezone', () => {
  it('extracts city from simple timezone', () => {
    expect(extractCityFromTimezone('Australia/Sydney')).toBe('Sydney');
  });

  it('extracts city from nested timezone path', () => {
    expect(extractCityFromTimezone('America/Indiana/Indianapolis')).toBe('Indianapolis');
  });

  it('replaces underscores with spaces', () => {
    expect(extractCityFromTimezone('America/New_York')).toBe('New York');
  });

  it('returns null for null input', () => {
    expect(extractCityFromTimezone(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractCityFromTimezone(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractCityFromTimezone('')).toBeNull();
  });

  it('returns null for UTC', () => {
    expect(extractCityFromTimezone('UTC')).toBeNull();
  });

  it('handles timezone with multiple underscores', () => {
    expect(extractCityFromTimezone('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
  });
});
