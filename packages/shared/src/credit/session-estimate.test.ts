import { describe, expect, it } from 'vitest';
import { deriveSessionEstimate } from './session-estimate';
import { DEFAULT_BALO_FEE_BPS } from '../pricing';

describe('deriveSessionEstimate (BAL-478 / BAL-378 Q4)', () => {
  it('golden numbers: A$300/hr expert, 30 minutes, default fee', () => {
    const result = deriveSessionEstimate({ expertHourlyMinor: 30_000, estimatedMinutes: 30 });
    expect(result).toEqual({
      baloFeeBps: 2500,
      clientRateMinorPerMinute: 625,
      expertRateMinorPerMinute: 500,
      estimateMinor: 18_750,
    });
  });

  /**
   * ⚠ THE ORDERING PIN (mutation proof). This case is ordering-sensitive ON PURPOSE (BAL-378
   * Q4): dividing the raw hourly rate into minutes FIRST and THEN marking it up gives 258;
   * marking up the hourly rate FIRST and THEN dividing (the shipped, correct order) gives 257.
   * This assertion goes RED if anyone "simplifies" the composition back to the wrong order.
   */
  it('golden numbers: A$123.45/hr expert, 45 minutes — the ordering pin', () => {
    const result = deriveSessionEstimate({ expertHourlyMinor: 12_345, estimatedMinutes: 45 });
    expect(result.clientRateMinorPerMinute).toBe(257);
    expect(result.estimateMinor).toBe(11_565);
  });

  it('omitted baloFeeBps defaults to DEFAULT_BALO_FEE_BPS', () => {
    const result = deriveSessionEstimate({ expertHourlyMinor: 30_000, estimatedMinutes: 10 });
    expect(result.baloFeeBps).toBe(DEFAULT_BALO_FEE_BPS);
  });

  it('an explicit baloFeeBps of 0 makes the client rate equal the expert rate (?? is not ||)', () => {
    const result = deriveSessionEstimate({
      expertHourlyMinor: 30_000,
      estimatedMinutes: 10,
      baloFeeBps: 0,
    });
    expect(result.baloFeeBps).toBe(0);
    expect(result.clientRateMinorPerMinute).toBe(result.expertRateMinorPerMinute);
  });

  it('estimatedMinutes: 0 yields estimateMinor: 0', () => {
    const result = deriveSessionEstimate({ expertHourlyMinor: 30_000, estimatedMinutes: 0 });
    expect(result.estimateMinor).toBe(0);
  });

  it('expertHourlyMinor: 0 yields every figure 0', () => {
    const result = deriveSessionEstimate({ expertHourlyMinor: 0, estimatedMinutes: 30 });
    expect(result).toEqual({
      baloFeeBps: 2500,
      clientRateMinorPerMinute: 0,
      expertRateMinorPerMinute: 0,
      estimateMinor: 0,
    });
  });

  it('the result key set is exactly the four documented fields', () => {
    const result = deriveSessionEstimate({ expertHourlyMinor: 30_000, estimatedMinutes: 30 });
    expect(Object.keys(result).sort()).toEqual([
      'baloFeeBps',
      'clientRateMinorPerMinute',
      'estimateMinor',
      'expertRateMinorPerMinute',
    ]);
  });
});
