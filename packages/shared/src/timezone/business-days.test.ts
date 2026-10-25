import { describe, it, expect } from 'vitest';
import { addBusinessDays, businessDaysBetween } from './business-days';

// 2026-10-26 is a Monday.
const MON = new Date('2026-10-26T10:00:00Z');
const FRI = new Date('2026-10-30T10:00:00Z');
const SAT = new Date('2026-10-31T10:00:00Z');
const SUN = new Date('2026-11-01T10:00:00Z');
const NEXT_MON = new Date('2026-11-02T10:00:00Z');

describe('businessDaysBetween', () => {
  it('counts Friday to Monday as one business day', () => {
    expect(businessDaysBetween(FRI, NEXT_MON)).toBe(1);
  });

  it('counts a full week as five', () => {
    expect(businessDaysBetween(MON, NEXT_MON)).toBe(5);
  });

  it('is zero for the same day, a reversed range, or a weekend-only range', () => {
    expect(businessDaysBetween(MON, MON)).toBe(0);
    expect(businessDaysBetween(NEXT_MON, MON)).toBe(0);
    expect(businessDaysBetween(SAT, SUN)).toBe(0);
  });

  it('excludes the start day and includes the end day', () => {
    expect(businessDaysBetween(MON, new Date('2026-10-27T00:00:00Z'))).toBe(1);
  });
});

describe('addBusinessDays', () => {
  it('goes back five business days to the previous Monday, keeping the time', () => {
    expect(addBusinessDays(MON, -5).toISOString()).toBe('2026-10-19T10:00:00.000Z');
  });

  it('skips the weekend going forward', () => {
    expect(addBusinessDays(FRI, 1).toISOString()).toBe(NEXT_MON.toISOString());
  });

  it('moves from a weekend start to the next weekday for one step', () => {
    expect(addBusinessDays(SAT, 1).toISOString()).toBe(NEXT_MON.toISOString());
    expect(addBusinessDays(SUN, -1).toISOString()).toBe(FRI.toISOString());
  });

  it('returns an equal date for zero and does not mutate the input', () => {
    const copy = addBusinessDays(MON, 0);
    expect(copy.getTime()).toBe(MON.getTime());
    expect(copy).not.toBe(MON);
  });

  it('round-trips with businessDaysBetween for a weekday', () => {
    for (let n = 0; n <= 12; n += 1) {
      expect(businessDaysBetween(addBusinessDays(FRI, -n), FRI)).toBe(n);
    }
  });
});
