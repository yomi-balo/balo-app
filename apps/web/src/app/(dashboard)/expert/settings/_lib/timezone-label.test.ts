import { describe, it, expect } from 'vitest';
import { formatWallClock, shortOffset, timezoneLabel } from './timezone-label';

// A fixed instant in Melbourne standard time (AEST, GMT+10) — no DST ambiguity.
const JULY = new Date('2026-07-14T05:04:00Z');
// The same zone in daylight time (AEDT, GMT+11).
const JANUARY = new Date('2026-01-13T05:04:00Z');

describe('shortOffset', () => {
  it('returns the GMT offset for a zone at the given instant', () => {
    expect(shortOffset('Australia/Melbourne', JULY)).toBe('GMT+10');
    expect(shortOffset('Australia/Melbourne', JANUARY)).toBe('GMT+11');
  });

  it('returns an empty string for a zone Intl cannot resolve', () => {
    expect(shortOffset('Not/A_Zone', JULY)).toBe('');
  });
});

describe('timezoneLabel', () => {
  it('names UTC as-is', () => {
    expect(timezoneLabel('UTC', JULY)).toBe('UTC');
  });

  it('names a city zone with its current offset', () => {
    expect(timezoneLabel('Australia/Melbourne', JULY)).toBe('Melbourne (GMT+10)');
    expect(timezoneLabel('America/New_York', JULY)).toBe('New York (GMT-4)');
  });

  it('drops the offset when Intl cannot resolve the zone', () => {
    expect(timezoneLabel('Not/A_Zone', JULY)).toBe('A Zone');
  });
});

describe('formatWallClock', () => {
  it('formats the weekday and 12-hour time in the zone', () => {
    expect(formatWallClock('UTC', JULY)).toBe('Tue 5:04 AM');
    expect(formatWallClock('Australia/Melbourne', JULY)).toBe('Tue 3:04 PM');
  });

  it('crosses the date line into the next weekday', () => {
    expect(formatWallClock('Pacific/Auckland', new Date('2026-07-14T13:30:00Z'))).toBe(
      'Wed 1:30 AM'
    );
  });

  it('returns an empty string for a zone Intl cannot resolve', () => {
    expect(formatWallClock('Not/A_Zone', JULY)).toBe('');
  });
});
