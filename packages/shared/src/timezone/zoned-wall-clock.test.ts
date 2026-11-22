import { describe, expect, it } from 'vitest';
import { zonedWallClockToUtc } from './index';

describe('zonedWallClockToUtc', () => {
  it('reads a Melbourne AEDT wall time as UTC+11', () => {
    expect(
      zonedWallClockToUtc('Australia/Melbourne', {
        year: 2026,
        month: 11,
        day: 23,
        hour: 9,
        minute: 0,
      }).toISOString()
    ).toBe('2026-11-22T22:00:00.000Z');
  });

  it('reads a Melbourne AEST wall time as UTC+10', () => {
    expect(
      zonedWallClockToUtc('Australia/Melbourne', {
        year: 2026,
        month: 6,
        day: 15,
        hour: 9,
        minute: 0,
      }).toISOString()
    ).toBe('2026-06-14T23:00:00.000Z');
  });

  it('is the identity for UTC', () => {
    expect(
      zonedWallClockToUtc('UTC', {
        year: 2026,
        month: 3,
        day: 2,
        hour: 9,
        minute: 30,
      }).toISOString()
    ).toBe('2026-03-02T09:30:00.000Z');
  });

  it('handles a western zone in daylight time', () => {
    expect(
      zonedWallClockToUtc('America/New_York', {
        year: 2026,
        month: 7,
        day: 1,
        hour: 9,
        minute: 0,
      }).toISOString()
    ).toBe('2026-07-01T13:00:00.000Z');
  });

  it('resolves the morning after a DST start (Sydney, 2026-10-04) with the new offset', () => {
    expect(
      zonedWallClockToUtc('Australia/Sydney', {
        year: 2026,
        month: 10,
        day: 5,
        hour: 9,
        minute: 0,
      }).toISOString()
    ).toBe('2026-10-04T22:00:00.000Z');
  });
});
