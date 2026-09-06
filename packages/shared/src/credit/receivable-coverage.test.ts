import { describe, expect, it } from 'vitest';
import {
  CASH_CREDIT_REASONS,
  creditCoversOutstandingDebt,
  isCashCreditReason,
} from './receivable-coverage';

/**
 * BAL-535 (ADR-1040 Amendment 6 §F). The invariant suite
 * (`packages/db/src/invariants/an-account-hold-outlives-only-an-unpaid-balance.test.ts`) covers
 * the same function from the money-invariant side; per
 * `reference_shared_pkg_coverage_understated_in_isolation`, this co-located unit test is kept
 * anyway so `@balo/shared`'s own coverage report is not understated in isolation.
 */
describe('creditCoversOutstandingDebt', () => {
  it('is false for any negative balance, with no promo in play', () => {
    expect(creditCoversOutstandingDebt(-1, 0)).toBe(false);
    expect(creditCoversOutstandingDebt(-50_000, 0)).toBe(false);
  });

  it('is true at exactly zero — the boundary is >= 0, not > 0', () => {
    expect(creditCoversOutstandingDebt(0, 0)).toBe(true);
  });

  it('is true for any positive balance, with no promo in play', () => {
    expect(creditCoversOutstandingDebt(1, 0)).toBe(true);
    expect(creditCoversOutstandingDebt(100_000, 0)).toBe(true);
  });

  it('⚠⚠ B1 — a promo grant that landed since the debt opened is discounted back out', () => {
    // The exact defect the fix round names: a $50 promo in an EARLIER transaction is already
    // inside `balance_minor`, so one cent of cash used to clear the whole receivable.
    expect(creditCoversOutstandingDebt(1, 5_000)).toBe(false);
    // …and the same shape at the late-open (R3b) sites, which read committed wallet state.
    expect(creditCoversOutstandingDebt(0, 5_000)).toBe(false);
  });

  it('⚠⚠ B1 — cash that covers the debt on top of the promo still clears', () => {
    // Balance $50.01 of which $50.00 is promo ⇒ 1 cent of cash against a debt already at zero.
    expect(creditCoversOutstandingDebt(5_001, 5_000)).toBe(true);
    expect(creditCoversOutstandingDebt(5_000, 5_000)).toBe(true);
    expect(creditCoversOutstandingDebt(4_999, 5_000)).toBe(false);
  });

  it('takes exactly two balance arguments — the receivable amount is not part of the signature', () => {
    expect(creditCoversOutstandingDebt).toHaveLength(2);
  });
});

describe('CASH_CREDIT_REASONS / isCashCreditReason', () => {
  it('is exactly the two cash reasons', () => {
    expect([...CASH_CREDIT_REASONS]).toEqual(['manual_purchase', 'auto_topup']);
  });

  it.each(['manual_purchase', 'auto_topup'])('accepts %s', (reason) => {
    expect(isCashCreditReason(reason)).toBe(true);
  });

  it.each(['promo', 'overdraft_settlement', 'session_consume', 'dormancy_expiry', ''])(
    'rejects %s',
    (reason) => {
      expect(isCashCreditReason(reason)).toBe(false);
    }
  );
});
