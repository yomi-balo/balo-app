import { describe, it, expect } from 'vitest';
import {
  formatLocalShortDate,
  formatUtcShortDate,
  formatUtcLongDate,
  formatUtcMonthYear,
} from './local-date';

describe('formatUtcShortDate', () => {
  it('formats a short "D Mon" date in UTC', () => {
    expect(formatUtcShortDate('2026-06-12T09:00:00.000Z')).toBe('12 Jun');
  });

  it('reads the UTC calendar day regardless of the time of day', () => {
    // 23:30Z is still the 12th in UTC.
    expect(formatUtcShortDate('2026-06-12T23:30:00.000Z')).toBe('12 Jun');
  });

  it('covers the year boundaries', () => {
    expect(formatUtcShortDate('2026-01-01T00:00:00.000Z')).toBe('1 Jan');
    expect(formatUtcShortDate('2026-12-31T00:00:00.000Z')).toBe('31 Dec');
  });
});

describe('formatLocalShortDate', () => {
  it('formats a short "D Mon" date in the local zone (== UTC when TZ=UTC)', () => {
    expect(formatLocalShortDate('2026-06-19T09:00:00.000Z')).toBe('19 Jun');
  });
});

describe('formatUtcMonthYear', () => {
  it('formats "Mon YYYY" in UTC from an ISO string', () => {
    expect(formatUtcMonthYear('2026-10-14T09:00:00.000Z')).toBe('Oct 2026');
  });

  it('reads the UTC month at the boundary, not the local one', () => {
    expect(formatUtcMonthYear('2026-10-31T23:59:59.000Z')).toBe('Oct 2026');
    expect(formatUtcMonthYear('2026-11-01T00:00:00.000Z')).toBe('Nov 2026');
  });

  it('accepts a Date and covers the year boundary', () => {
    expect(formatUtcMonthYear(new Date('2026-12-31T23:30:00.000Z'))).toBe('Dec 2026');
    expect(formatUtcMonthYear(new Date('2027-01-01T00:00:00.000Z'))).toBe('Jan 2027');
  });
});

describe('formatUtcLongDate', () => {
  it('formats "D Month YYYY" in UTC from an ISO string', () => {
    expect(formatUtcLongDate('2026-08-13T00:00:00.000Z')).toBe('13 August 2026');
  });

  it('accepts a Date and reads the UTC calendar day', () => {
    // 23:30Z on the 13th is still the 13th in UTC (no local-zone rollover).
    expect(formatUtcLongDate(new Date('2026-08-13T23:30:00.000Z'))).toBe('13 August 2026');
  });
});
