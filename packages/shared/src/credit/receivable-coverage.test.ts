import { describe, expect, it } from 'vitest';
import {
  CASH_CREDIT_REASONS,
  DEBT_COVERING_CREDIT_REASONS,
  amountNeededToClearHold,
  creditCoversOutstandingDebt,
  isDebtCoveringCreditReason,
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

describe('CASH_CREDIT_REASONS', () => {
  // BAL-474 DELETED `isCashCreditReason` (its only non-test consumer, `dispatch.ts`, now gates the
  // clear on `isDebtCoveringCreditReason`); the cash list itself is unchanged and is still the
  // derivation base for the debt-covering set and for `CashCreditReason`.
  it('is exactly the two cash reasons', () => {
    expect([...CASH_CREDIT_REASONS]).toEqual(['manual_purchase', 'auto_topup']);
  });
});

describe('DEBT_COVERING_CREDIT_REASONS / isDebtCoveringCreditReason (BAL-474, Amendment 7 §F)', () => {
  it('is the cash set plus overdraft_settlement, in that order', () => {
    expect([...DEBT_COVERING_CREDIT_REASONS]).toEqual([
      'manual_purchase',
      'auto_topup',
      'overdraft_settlement',
    ]);
  });

  it.each(['manual_purchase', 'auto_topup', 'overdraft_settlement'])('accepts %s', (reason) => {
    expect(isDebtCoveringCreditReason(reason)).toBe(true);
  });

  it.each(['promo', 'session_consume', 'dormancy_expiry', 'adjustment', ''])(
    'rejects %s',
    (reason) => {
      expect(isDebtCoveringCreditReason(reason)).toBe(false);
    }
  );
});

describe('amountNeededToClearHold (BAL-474, Amendment 7 §G)', () => {
  it('is the whole negative balance when no promo landed since the debt', () => {
    expect(amountNeededToClearHold(-24_000, 0)).toBe(24_000);
  });

  it('adds back the promo the predicate discounts (a top-up figure, not a debt)', () => {
    expect(amountNeededToClearHold(-24_000, 5_000)).toBe(29_000);
    expect(amountNeededToClearHold(2_000, 12_000)).toBe(10_000);
  });

  it('is zero exactly when the balance already covers the debt — never negative', () => {
    expect(amountNeededToClearHold(0, 0)).toBe(0);
    expect(amountNeededToClearHold(5_000, 5_000)).toBe(0);
    expect(amountNeededToClearHold(10_000, 0)).toBe(0);
  });

  it('paying it covers, and one cent less does not', () => {
    const balance = -15_500;
    const promo = 5_000;
    const needed = amountNeededToClearHold(balance, promo);
    expect(creditCoversOutstandingDebt(balance + needed, promo)).toBe(true);
    expect(creditCoversOutstandingDebt(balance + needed - 1, promo)).toBe(false);
  });
});
