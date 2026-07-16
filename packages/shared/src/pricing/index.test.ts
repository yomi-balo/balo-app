import { describe, it, expect } from 'vitest';
import {
  applyBaloFee,
  DEFAULT_BALO_FEE_BPS,
  DEFAULT_OVERDRAFT_CEILING_MINOR,
  DEFAULT_TOPUP_RELOAD_MINOR,
  DEFAULT_TOPUP_THRESHOLD_MINOR,
  deriveTmTotalCents,
  DORMANCY_REMINDER_WINDOWS_DAYS,
  feeBpsToPercent,
  formatFeePercent,
  FX_DISPLAY_STALENESS_MS,
  isFxRateStale,
  isValidBaloFeeBps,
  MAX_BALO_FEE_BPS,
  MIN_BALO_FEE_BPS,
  parseFeePercentToBps,
  sumEstimatedMinutes,
  WALLET_EXPIRY_MONTHS,
} from './index';

/**
 * Unit tests for the pure T&M pricing helpers (BAL-294). Mocks nothing —
 * `@balo/shared/pricing` has no `db` import and no I/O. Price/effort calculation is
 * the "ALWAYS test" category (rounding edges, zero/empty, large sums). This module
 * is the single source of truth for the T&M total, shared by the coherence guard
 * and the web composer, so the math is locked here.
 */

describe('deriveTmTotalCents', () => {
  it('derives 90 min at A$180/hr (18_000c) → A$270 (27_000c)', () => {
    // 90/60 × 18_000 = 1.5 × 18_000 = 27_000 — exact.
    expect(deriveTmTotalCents(90, 18_000)).toBe(27_000);
  });

  it('rounds 50 min at A$100/hr (10_000c) → 8_333c (round(8333.33…))', () => {
    // 50/60 × 10_000 = 8333.33… → rounds to 8_333.
    expect(deriveTmTotalCents(50, 10_000)).toBe(8_333);
  });

  it('rounds half away from zero (10 min at 10_000c → 1_667c)', () => {
    // 10/60 × 10_000 = 1666.66… → 1_667.
    expect(deriveTmTotalCents(10, 10_000)).toBe(1_667);
  });

  it('returns 0 for zero minutes', () => {
    expect(deriveTmTotalCents(0, 18_000)).toBe(0);
  });

  it('returns 0 for a zero rate', () => {
    expect(deriveTmTotalCents(600, 0)).toBe(0);
  });

  it('handles exactly one hour (60 min → the full rate)', () => {
    expect(deriveTmTotalCents(60, 18_000)).toBe(18_000);
  });

  it('handles large sums without precision loss (6_000h = 360_000 min at 25_000c)', () => {
    // 360_000/60 × 25_000 = 6_000 × 25_000 = 150_000_000c (A$1.5M).
    expect(deriveTmTotalCents(360_000, 25_000)).toBe(150_000_000);
  });

  it('rounds a fractional-hour large sum (125 min at 33_333c → 69_443c)', () => {
    // 125/60 × 33_333 = 2.0833… × 33_333 = 69_443.75 → 69_444.
    expect(deriveTmTotalCents(125, 33_333)).toBe(69_444);
  });
});

describe('sumEstimatedMinutes', () => {
  it('sums present minutes', () => {
    expect(sumEstimatedMinutes([{ estimatedMinutes: 30 }, { estimatedMinutes: 90 }])).toBe(120);
  });

  it('treats null effort as 0', () => {
    expect(sumEstimatedMinutes([{ estimatedMinutes: 60 }, { estimatedMinutes: null }])).toBe(60);
  });

  it('returns 0 for an empty milestone list', () => {
    expect(sumEstimatedMinutes([])).toBe(0);
  });

  it('returns 0 when every milestone is null', () => {
    expect(sumEstimatedMinutes([{ estimatedMinutes: null }, { estimatedMinutes: null }])).toBe(0);
  });

  it('sums a large mixed set', () => {
    expect(
      sumEstimatedMinutes([
        { estimatedMinutes: 100_000 },
        { estimatedMinutes: null },
        { estimatedMinutes: 260_000 },
      ])
    ).toBe(360_000);
  });

  it('composes with deriveTmTotalCents end-to-end', () => {
    const total = deriveTmTotalCents(
      sumEstimatedMinutes([{ estimatedMinutes: 30 }, { estimatedMinutes: 60 }]),
      18_000
    );
    // 90 min → 27_000c.
    expect(total).toBe(27_000);
  });
});

describe('applyBaloFee', () => {
  it('grosses A$10,000 (1_000_000c) up by 25% → A$12,500 (1_250_000c)', () => {
    // 1_000_000 × (10_000 + 2_500) / 10_000 = 1_000_000 × 1.25 = 1_250_000 — exact.
    expect(applyBaloFee(1_000_000, 2_500)).toBe(1_250_000);
  });

  it('rounds half away from zero (10 000c at 2 500 bps stays exact; 1c at 5 000 bps → 2c)', () => {
    // 1 × 15_000 / 10_000 = 1.5 → rounds to 2 (half away from zero).
    expect(applyBaloFee(1, 5_000)).toBe(2);
  });

  it('is the identity when feeBps = 0', () => {
    expect(applyBaloFee(999_999, 0)).toBe(999_999);
  });

  it('doubles the amount when feeBps = 10_000 (100%)', () => {
    expect(applyBaloFee(1_234_567, 10_000)).toBe(2_469_134);
  });

  it('handles large sums without precision loss', () => {
    // 150_000_000 × 1.25 = 187_500_000 (A$1.875M).
    expect(applyBaloFee(150_000_000, 2_500)).toBe(187_500_000);
  });

  it('exposes DEFAULT_BALO_FEE_BPS as 2500', () => {
    expect(DEFAULT_BALO_FEE_BPS).toBe(2500);
  });
});

describe('feeBpsToPercent', () => {
  it('converts whole-percent bps (2500 → 25)', () => {
    expect(feeBpsToPercent(2500)).toBe(25);
  });

  it('converts fractional-percent bps (1750 → 17.5)', () => {
    expect(feeBpsToPercent(1750)).toBe(17.5);
  });

  it('maps the range bounds (0 → 0, 10000 → 100)', () => {
    expect(feeBpsToPercent(MIN_BALO_FEE_BPS)).toBe(0);
    expect(feeBpsToPercent(MAX_BALO_FEE_BPS)).toBe(100);
  });
});

describe('formatFeePercent', () => {
  it('renders whole percents (2500 → "25%")', () => {
    expect(formatFeePercent(2500)).toBe('25%');
  });

  it('renders fractional percents (1750 → "17.5%")', () => {
    expect(formatFeePercent(1750)).toBe('17.5%');
  });

  it('renders the bounds ("0%" and "100%")', () => {
    expect(formatFeePercent(0)).toBe('0%');
    expect(formatFeePercent(10_000)).toBe('100%');
  });
});

describe('isValidBaloFeeBps', () => {
  it('accepts the inclusive range bounds', () => {
    expect(isValidBaloFeeBps(0)).toBe(true);
    expect(isValidBaloFeeBps(2500)).toBe(true);
    expect(isValidBaloFeeBps(10_000)).toBe(true);
  });

  it('rejects out-of-range values', () => {
    expect(isValidBaloFeeBps(-1)).toBe(false);
    expect(isValidBaloFeeBps(10_001)).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(isValidBaloFeeBps(1750.5)).toBe(false);
    expect(isValidBaloFeeBps(Number.NaN)).toBe(false);
  });
});

describe('parseFeePercentToBps', () => {
  it('parses a fractional percent ("17.5" → 1750)', () => {
    expect(parseFeePercentToBps('17.5')).toEqual({ ok: true, bps: 1750 });
  });

  it('parses a whole percent ("25" → 2500)', () => {
    expect(parseFeePercentToBps('25')).toEqual({ ok: true, bps: 2500 });
  });

  it('strips a trailing percent sign ("25%" → 2500)', () => {
    expect(parseFeePercentToBps('25%')).toEqual({ ok: true, bps: 2500 });
  });

  it('tolerates surrounding whitespace and a spaced percent ("  17.5 % " → 1750)', () => {
    expect(parseFeePercentToBps('  17.5 % ')).toEqual({ ok: true, bps: 1750 });
  });

  it('parses the range bounds ("0" → 0, "100" → 10000)', () => {
    expect(parseFeePercentToBps('0')).toEqual({ ok: true, bps: 0 });
    expect(parseFeePercentToBps('100')).toEqual({ ok: true, bps: 10_000 });
  });

  it('rounds two-decimal percents to whole bps ("17.99" → 1799)', () => {
    expect(parseFeePercentToBps('17.99')).toEqual({ ok: true, bps: 1799 });
  });

  it('rejects an empty / whitespace-only input', () => {
    expect(parseFeePercentToBps('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseFeePercentToBps('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseFeePercentToBps('%')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a non-numeric input', () => {
    expect(parseFeePercentToBps('abc')).toEqual({ ok: false, reason: 'not_a_number' });
    expect(parseFeePercentToBps('1.2.3')).toEqual({ ok: false, reason: 'not_a_number' });
  });

  it('rejects more than two decimal places rather than silently rounding', () => {
    expect(parseFeePercentToBps('17.533')).toEqual({ ok: false, reason: 'too_many_decimals' });
  });

  it('rejects a leading minus sign as not a number (a fee percent is never negative)', () => {
    // The leading `-?` was removed from the numeric regex, so any negative fails the
    // shape check BEFORE the range check — `-0` no longer parses to an accepted 0%.
    expect(parseFeePercentToBps('-0')).toEqual({ ok: false, reason: 'not_a_number' });
    expect(parseFeePercentToBps('-1')).toEqual({ ok: false, reason: 'not_a_number' });
    expect(parseFeePercentToBps('-5')).toEqual({ ok: false, reason: 'not_a_number' });
  });

  it('rejects out-of-range percents', () => {
    expect(parseFeePercentToBps('150')).toEqual({ ok: false, reason: 'out_of_range' });
  });
});

describe('Client Credit System platform-money constants (BAL-376)', () => {
  it('exposes DEFAULT_OVERDRAFT_CEILING_MINOR as 15000 (AUD 150)', () => {
    expect(DEFAULT_OVERDRAFT_CEILING_MINOR).toBe(15000);
  });

  it('exposes DEFAULT_TOPUP_THRESHOLD_MINOR as 2000 (AUD 20)', () => {
    expect(DEFAULT_TOPUP_THRESHOLD_MINOR).toBe(2000);
  });

  it('exposes DEFAULT_TOPUP_RELOAD_MINOR as 10000 (AUD 100)', () => {
    expect(DEFAULT_TOPUP_RELOAD_MINOR).toBe(10000);
  });

  it('exposes WALLET_EXPIRY_MONTHS as 12', () => {
    expect(WALLET_EXPIRY_MONTHS).toBe(12);
  });
});

describe('Dormancy / display-FX constants (BAL-380)', () => {
  it('exposes the 60d + 30d reminder bands, widest → nearest', () => {
    expect(DORMANCY_REMINDER_WINDOWS_DAYS).toEqual([60, 30]);
  });

  it('exposes FX_DISPLAY_STALENESS_MS as 48 hours in milliseconds', () => {
    expect(FX_DISPLAY_STALENESS_MS).toBe(48 * 60 * 60 * 1000);
  });
});

describe('isFxRateStale', () => {
  const now = new Date('2026-07-16T12:00:00Z');

  it('is not stale at exactly 48h old (strict >, boundary excluded)', () => {
    const asOf = new Date(now.getTime() - FX_DISPLAY_STALENESS_MS);
    expect(isFxRateStale(asOf, now)).toBe(false);
  });

  it('is stale one millisecond past 48h', () => {
    const asOf = new Date(now.getTime() - FX_DISPLAY_STALENESS_MS - 1);
    expect(isFxRateStale(asOf, now)).toBe(true);
  });

  it('is not stale for a fresh (just-now) quote', () => {
    expect(isFxRateStale(now, now)).toBe(false);
  });

  it('is stale for a quote days old', () => {
    const asOf = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    expect(isFxRateStale(asOf, now)).toBe(true);
  });
});
