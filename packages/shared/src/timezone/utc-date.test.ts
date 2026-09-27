import { describe, expect, it } from 'vitest';
import { formatLongUtc, formatShortUtc } from './utc-date';

/**
 * BAL-572 — moved verbatim from `apps/web/src/lib/format/utc-date.ts` (which had no test of
 * its own; these pin the two formatters at their new shared home before web re-points at it).
 */

describe('formatShortUtc', () => {
  it('formats day + short month, UTC', () => {
    expect(formatShortUtc(new Date('2026-07-04T00:00:00Z'))).toBe('4 Jul');
  });

  it("renders in UTC regardless of the stored instant's local offset", () => {
    // 23:30 UTC on the 4th is still "4 Jul" in UTC, even though it would be the 5th in
    // most zones east of Greenwich.
    expect(formatShortUtc(new Date('2026-07-04T23:30:00Z'))).toBe('4 Jul');
  });

  it('never carries a year', () => {
    expect(formatShortUtc(new Date('2026-12-31T10:00:00Z'))).not.toContain('2026');
  });
});

describe('formatLongUtc', () => {
  it('formats day + short month + year, UTC', () => {
    expect(formatLongUtc(new Date('2026-07-09T00:00:00Z'))).toBe('9 Jul 2026');
  });

  it("renders in UTC regardless of the stored instant's local offset", () => {
    expect(formatLongUtc(new Date('2026-08-12T09:00:00Z'))).toBe('12 Aug 2026');
  });

  it('carries the year, unlike formatShortUtc', () => {
    expect(formatLongUtc(new Date('2026-12-31T10:00:00Z'))).toContain('2026');
  });
});
