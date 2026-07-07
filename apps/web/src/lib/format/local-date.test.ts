import { describe, it, expect } from 'vitest';
import { formatLocalShortDate, formatUtcShortDate } from './local-date';

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
