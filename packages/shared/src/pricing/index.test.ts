import { describe, it, expect } from 'vitest';
import {
  applyBaloFee,
  clientBoundToExpertRateCents,
  DEFAULT_BALO_FEE_BPS,
  DEFAULT_OVERDRAFT_CEILING_MINOR,
  DEFAULT_TOPUP_RELOAD_MINOR,
  DEFAULT_TOPUP_THRESHOLD_MINOR,
  deriveMinuteRateCents,
  deriveTmTotalCents,
  DORMANCY_REMINDER_WINDOWS_DAYS,
  feeBpsToPercent,
  formatFeePercent,
  FX_DISPLAY_STALENESS_MS,
  isFxRateStale,
  isValidBaloFeeBps,
  LOW_BALANCE_WARNING_MINUTES,
  MAX_BALO_FEE_BPS,
  MAX_SESSION_MINUTES,
  MIN_BALO_FEE_BPS,
  NEAR_WRAP_MINUTES,
  OVERDRAFT_GRACE_MINUTES,
  parseFeePercentToBps,
  PENDING_STALE_CANCEL_MINUTES,
  publicDisplayRatePerMinute,
  sumEstimatedMinutes,
  TOPUP_IN_FLIGHT_TTL_MS,
  TOPUP_RECONCILE_AFTER_MS,
  TOPUP_RECONCILE_ESCALATE_AFTER_MS,
  WALLET_EXPIRY_MONTHS,
  WRAPPED_IDLE_END_MINUTES,
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

/**
 * BAL-493 / D1 — the ONE public-display markup wrapper. Before this existed both public
 * serializers emitted `rateCents / 100`, i.e. a rate LOWER than the client is actually
 * charged. These assertions are the arithmetic half of the AC-5 serializer-boundary
 * invariant (the DTO-shape half lives at each serializer's own test).
 */
describe('publicDisplayRatePerMinute (BAL-493 / D1)', () => {
  it('applies the default Balo fee and converts to dollars (250c → 3.13)', () => {
    // applyBaloFee(250, 2500) = round(250 × 12500 / 10000) = round(312.5) = 313 → 3.13
    expect(publicDisplayRatePerMinute(250)).toBe(3.13);
  });

  it('marks up the profile fixture rate (950c → 11.88)', () => {
    // applyBaloFee(950, 2500) = round(1187.5) = 1188 → 11.88
    expect(publicDisplayRatePerMinute(950)).toBe(11.88);
  });

  it('keeps a zero rate as 0, never null', () => {
    expect(publicDisplayRatePerMinute(0)).toBe(0);
  });

  it('maps a null rate to null (no rate set)', () => {
    expect(publicDisplayRatePerMinute(null)).toBeNull();
  });

  it('rounds to whole cents before dividing (no sub-cent float leak)', () => {
    // 333 × 1.25 = 416.25 → round 416 → 4.16 (not 4.1625)
    expect(publicDisplayRatePerMinute(333)).toBe(4.16);
    // 1 × 1.25 = 1.25 → round 1 → 0.01
    expect(publicDisplayRatePerMinute(1)).toBe(0.01);
  });

  it('agrees with applyBaloFee at the default fee for a large rate', () => {
    expect(publicDisplayRatePerMinute(12_000)).toBe(
      applyBaloFee(12_000, DEFAULT_BALO_FEE_BPS) / 100
    );
  });
});

/**
 * BAL-493 fix round 1 — the INVERSE of the D1 markup, and the fee-concealment leak it closes.
 *
 * The rate slider is CLIENT-facing (it is the number D1 now displays); `expert-search.ts`'s
 * `gte`/`lte` are EXPERT-facing (raw `expert_profiles.rate_cents`). Before this function the
 * web boundary handed one straight to the other, so an anonymous visitor could bisect
 * `?rateMax=` until an expert dropped out, recover that expert's raw rate, and divide the
 * displayed rate by it to read Balo's markup to the basis point.
 *
 * ⚠ THE ASSERTIONS BELOW ARE ROUND-TRIPS THROUGH `applyBaloFee`, NOT RESTATEMENTS OF THE
 * FORMULA. Each boundary case names the raw rate that must be IN and the adjacent one that
 * must be OUT, and proves the claim by re-deriving what that raw rate DISPLAYS. A
 * floor/ceil swap fails here; a test that only recomputed `clientCents × 10000 / 12500`
 * would not.
 */
describe('clientBoundToExpertRateCents (BAL-493 fix round 1 — inverse of applyBaloFee)', () => {
  const FEE = DEFAULT_BALO_FEE_BPS; // 2500 bps

  it('max: floors — clientMax 500c ⇒ expert bound 400c, so raw 400 is IN and raw 401 is OUT', () => {
    const bound = clientBoundToExpertRateCents(500, FEE, 'max');
    expect(bound).toBe(400);

    // raw 400 displays exactly the slider's max ⇒ must be admitted by `rate_cents <= bound`.
    expect(applyBaloFee(400, FEE)).toBe(500);
    expect(400).toBeLessThanOrEqual(bound);

    // raw 401 displays 501 — above the slider's max ⇒ must be excluded.
    expect(applyBaloFee(401, FEE)).toBe(501);
    expect(401).toBeGreaterThan(bound);
  });

  it('min: ceils — clientMin 500c ⇒ expert bound 400c, so raw 400 is IN and raw 399 is OUT', () => {
    const bound = clientBoundToExpertRateCents(500, FEE, 'min');
    expect(bound).toBe(400);

    // raw 400 displays exactly the slider's min ⇒ must be admitted by `rate_cents >= bound`.
    expect(applyBaloFee(400, FEE)).toBe(500);
    expect(400).toBeGreaterThanOrEqual(bound);

    // raw 399 displays 499 — below the slider's min ⇒ must be excluded.
    expect(applyBaloFee(399, FEE)).toBe(499);
    expect(399).toBeLessThan(bound);
  });

  it('floor and ceil diverge on a non-integral quotient (the whole reason mode exists)', () => {
    // 505 × 10000 / 12500 = 404.0 exactly → both agree.
    expect(clientBoundToExpertRateCents(505, FEE, 'max')).toBe(404);
    expect(clientBoundToExpertRateCents(505, FEE, 'min')).toBe(404);
    // 501 × 10000 / 12500 = 400.8 → max floors to 400, min ceils to 401.
    expect(clientBoundToExpertRateCents(501, FEE, 'max')).toBe(400);
    expect(clientBoundToExpertRateCents(501, FEE, 'min')).toBe(401);
  });

  it('every expert rate admitted by the max bound really displays at or under the client max', () => {
    const clientMax = 733;
    const bound = clientBoundToExpertRateCents(clientMax, FEE, 'max');
    for (let raw = 0; raw <= bound; raw += 1) {
      expect(applyBaloFee(raw, FEE)).toBeLessThanOrEqual(clientMax);
    }
    // …and the first rate the bound rejects really displays ABOVE it.
    expect(applyBaloFee(bound + 1, FEE)).toBeGreaterThan(clientMax);
  });

  it('every expert rate admitted by the min bound really displays at or over the client min', () => {
    const clientMin = 750; // 750 × 10000 / 12500 = 600 exactly.
    const bound = clientBoundToExpertRateCents(clientMin, FEE, 'min');
    expect(bound).toBe(600);
    for (let raw = bound; raw <= bound + 50; raw += 1) {
      expect(applyBaloFee(raw, FEE)).toBeGreaterThanOrEqual(clientMin);
    }
    // …and the last rate the bound rejects really displays BELOW it.
    expect(applyBaloFee(bound - 1, FEE)).toBeLessThan(clientMin);
  });

  /**
   * ⚠ DELIBERATE ASYMMETRY — do not "tighten" this into `ceil((clientCents - 0.5) / factor)`.
   * Because `applyBaloFee` rounds half-UP, a raw rate can display exactly the client's minimum
   * while sitting just BELOW the ceil'd bound (586 → 733). Ceil drops it. That is the safe
   * direction: the min bound never admits an expert whose displayed rate is under what the
   * client asked for.
   *
   * ⚠ THE MAX BOUND HAS THE MIRROR CASE — an earlier version of this comment claimed it did not.
   * At clientMax 501¢, raw 401 displays exactly 501 (`round(401 × 1.25) = 501`) and so ought to
   * be admitted, but `floor(400.8) = 400` excludes it. Both bounds are therefore CONSERVATIVE:
   * each errs toward the client, never over-admits, and never leaks. Unreachable from the
   * whole-dollar slider (`RATE_BOUNDS`), which cannot express 501¢. Do not "fix" either side by
   * widening it — the conservative direction is the one that keeps the displayed rate honest.
   */
  it('min is conservative, never permissive, when the quotient is not integral', () => {
    const clientMin = 733; // 733 × 10000 / 12500 = 586.4 → ceil 587.
    const bound = clientBoundToExpertRateCents(clientMin, FEE, 'min');
    expect(bound).toBe(587);
    // The dropped rate displays exactly the minimum — excluding it errs toward the client.
    expect(applyBaloFee(586, FEE)).toBe(733);
    expect(586).toBeLessThan(bound);
  });

  /**
   * The mirror of the case above, pinned so the corrected comment cannot rot back into the
   * false "floor is exact there" claim. Same conservative direction: the max bound excludes a
   * raw rate that displays EXACTLY the client's maximum.
   */
  it('max is conservative too, when the quotient is not integral', () => {
    const clientMax = 501; // 501 × 10000 / 12500 = 400.8 → floor 400.
    const bound = clientBoundToExpertRateCents(clientMax, FEE, 'max');
    expect(bound).toBe(400);
    // Raw 401 displays exactly the client's max, yet sits above the floor'd bound.
    expect(applyBaloFee(401, FEE)).toBe(501);
    expect(401).toBeGreaterThan(bound);
  });

  it('is the identity at a zero fee (no markup ⇒ client bound IS the expert bound)', () => {
    expect(clientBoundToExpertRateCents(500, MIN_BALO_FEE_BPS, 'max')).toBe(500);
    expect(clientBoundToExpertRateCents(500, MIN_BALO_FEE_BPS, 'min')).toBe(500);
  });

  it('keeps a zero bound at zero in both directions', () => {
    expect(clientBoundToExpertRateCents(0, FEE, 'max')).toBe(0);
    expect(clientBoundToExpertRateCents(0, FEE, 'min')).toBe(0);
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

describe('auto-top-up reconcile cadence (BAL-515)', () => {
  it('exposes TOPUP_RECONCILE_AFTER_MS as 5 minutes', () => {
    expect(TOPUP_RECONCILE_AFTER_MS).toBe(5 * 60 * 1000);
  });

  it('keeps TOPUP_RECONCILE_AFTER_MS STRICTLY below TOPUP_IN_FLIGHT_TTL_MS', () => {
    // ⚠ THE INEQUALITY IS THE CONTRACT, not the two literals. Past `TOPUP_IN_FLIGHT_TTL_MS` a
    // later balance crossing may RE-ARM `pending_topup_at`, and `armPendingTopup` overwrites
    // `pending_topup_triggering_entry_id` and NULLs `pending_topup_payment_intent_id` — the
    // reconcile's own evidence of which crossing it is repairing. A reconcile cutoff at or past
    // the TTL could therefore first see a marker only after the evidence had already been
    // erased, and the charged-but-uncredited reload this ticket exists to catch would again be
    // untraceable. Strictly below, with real retry budget left over.
    expect(TOPUP_RECONCILE_AFTER_MS).toBeLessThan(TOPUP_IN_FLIGHT_TTL_MS);
  });

  it('leaves at least 5 minutes of per-minute retry budget before the evidence can be erased', () => {
    // Not merely "below": the gap must be big enough for the per-minute sweep to retry a
    // deferred PaymentIntent read several times. 15 − 5 = 10 minutes ⇒ ~10 attempts.
    const retryBudgetMs = TOPUP_IN_FLIGHT_TTL_MS - TOPUP_RECONCILE_AFTER_MS;
    expect(retryBudgetMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it('exposes TOPUP_RECONCILE_ESCALATE_AFTER_MS as 1 hour', () => {
    expect(TOPUP_RECONCILE_ESCALATE_AFTER_MS).toBe(60 * 60 * 1000);
  });

  it('sets the escalation window WELL PAST the TTL, so nothing merely slow ever alarms', () => {
    // ⚠ THE INEQUALITY IS THE CONTRACT. This threshold only raises a deferred "still in flight"
    // record from `info` to `error`, and an alarm that fires on ordinary latency is worse than no
    // alarm — responders learn to ignore it. It must therefore sit far beyond both the reconcile
    // cutoff and the in-flight TTL, i.e. past every window in which a `processing` PaymentIntent
    // is still an ordinary race rather than a fault.
    expect(TOPUP_RECONCILE_ESCALATE_AFTER_MS).toBeGreaterThan(TOPUP_IN_FLIGHT_TTL_MS);
    expect(TOPUP_RECONCILE_ESCALATE_AFTER_MS).toBeGreaterThan(TOPUP_RECONCILE_AFTER_MS);
  });
});

describe('deriveMinuteRateCents (BAL-378)', () => {
  it('derives A$180/hr (18_000c) → A$3.00/min (300c) — exact', () => {
    // 18_000 / 60 = 300 exactly.
    expect(deriveMinuteRateCents(18_000)).toBe(300);
  });

  it('rounds half away from zero (10_000c/hr → round(166.66…) = 167c/min)', () => {
    // 10_000 / 60 = 166.66… → 167.
    expect(deriveMinuteRateCents(10_000)).toBe(167);
  });

  it('rounds a half-way case up (15_030c/hr → round(250.5) = 251c/min)', () => {
    // 15_030 / 60 = 250.5 → 251 (half away from zero).
    expect(deriveMinuteRateCents(15_030)).toBe(251);
  });

  it('returns 0 for a zero rate', () => {
    expect(deriveMinuteRateCents(0)).toBe(0);
  });

  it('composes with applyBaloFee (expert A$120/hr @25% → client A$150/hr → 250c/min)', () => {
    // 12_000 × 1.25 = 15_000/hr → 15_000/60 = 250c/min.
    expect(deriveMinuteRateCents(applyBaloFee(12_000, DEFAULT_BALO_FEE_BPS))).toBe(250);
  });
});

describe('Session drawdown / overdraft constants (BAL-378)', () => {
  it('exposes OVERDRAFT_GRACE_MINUTES as 30', () => {
    expect(OVERDRAFT_GRACE_MINUTES).toBe(30);
  });

  it('exposes LOW_BALANCE_WARNING_MINUTES as 8', () => {
    expect(LOW_BALANCE_WARNING_MINUTES).toBe(8);
  });

  it('exposes NEAR_WRAP_MINUTES as 10', () => {
    expect(NEAR_WRAP_MINUTES).toBe(10);
  });

  it('exposes the reaper safety/idle/stale caps (240 / 15 / 30)', () => {
    expect(MAX_SESSION_MINUTES).toBe(240);
    expect(WRAPPED_IDLE_END_MINUTES).toBe(15);
    expect(PENDING_STALE_CANCEL_MINUTES).toBe(30);
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
