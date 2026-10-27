import { describe, expect, it } from 'vitest';
import { deriveSessionEstimate } from './session-estimate';
import { DEFAULT_BALO_FEE_BPS, publicDisplayRatePerMinute } from '../pricing';

describe('deriveSessionEstimate (BAL-478)', () => {
  it('golden numbers: A$5.00/min expert, 30 minutes, default fee', () => {
    const result = deriveSessionEstimate({ expertRateMinorPerMinute: 500, estimatedMinutes: 30 });
    expect(result).toEqual({
      baloFeeBps: 2500,
      clientRateMinorPerMinute: 625,
      expertRateMinorPerMinute: 500,
      estimateMinor: 18_750,
    });
  });

  /**
   * ⚠ THE UNIT PIN (mutation proof). `rate_cents` is per MINUTE: a A$2.30/min expert bills the
   * client 288¢/min and earns 230¢/min. Reading the column as per-hour instead yields 5¢ / 4¢
   * (the production defect this pins) — this goes RED if anyone reintroduces a `/ 60`.
   */
  it('golden numbers: A$2.30/min expert, the 15-minute floor — the unit pin', () => {
    const result = deriveSessionEstimate({ expertRateMinorPerMinute: 230, estimatedMinutes: 15 });
    expect(result.clientRateMinorPerMinute).toBe(288);
    expect(result.expertRateMinorPerMinute).toBe(230);
    expect(result.estimateMinor).toBe(4_320);
  });

  it('at the default fee the client rate equals the public display rate, in cents', () => {
    for (const rate of [1, 230, 313, 499, 5_000]) {
      const result = deriveSessionEstimate({ expertRateMinorPerMinute: rate, estimatedMinutes: 1 });
      expect(result.clientRateMinorPerMinute / 100).toBe(publicDisplayRatePerMinute(rate));
    }
  });

  it('omitted baloFeeBps defaults to DEFAULT_BALO_FEE_BPS', () => {
    const result = deriveSessionEstimate({ expertRateMinorPerMinute: 500, estimatedMinutes: 10 });
    expect(result.baloFeeBps).toBe(DEFAULT_BALO_FEE_BPS);
  });

  it('an explicit baloFeeBps of 0 makes the client rate equal the expert rate (?? is not ||)', () => {
    const result = deriveSessionEstimate({
      expertRateMinorPerMinute: 500,
      estimatedMinutes: 10,
      baloFeeBps: 0,
    });
    expect(result.baloFeeBps).toBe(0);
    expect(result.clientRateMinorPerMinute).toBe(result.expertRateMinorPerMinute);
  });

  it('estimatedMinutes: 0 yields estimateMinor: 0', () => {
    const result = deriveSessionEstimate({ expertRateMinorPerMinute: 500, estimatedMinutes: 0 });
    expect(result.estimateMinor).toBe(0);
  });

  it('expertRateMinorPerMinute: 0 yields every figure 0', () => {
    const result = deriveSessionEstimate({ expertRateMinorPerMinute: 0, estimatedMinutes: 30 });
    expect(result).toEqual({
      baloFeeBps: 2500,
      clientRateMinorPerMinute: 0,
      expertRateMinorPerMinute: 0,
      estimateMinor: 0,
    });
  });

  it('the result key set is exactly the four documented fields', () => {
    const result = deriveSessionEstimate({ expertRateMinorPerMinute: 500, estimatedMinutes: 30 });
    expect(Object.keys(result).sort()).toEqual([
      'baloFeeBps',
      'clientRateMinorPerMinute',
      'estimateMinor',
      'expertRateMinorPerMinute',
    ]);
  });
});
