import { describe, expect, it } from 'vitest';
import { resolveSessionOverdraftShare } from './session-overdraft-share';

/**
 * BAL-474 (ADR-1040 Amendment 7 §A). The money-invariant suite
 * (`packages/db/src/invariants/a-session-never-settles-debt-it-did-not-incur.test.ts`) pins the
 * same function over the worked examples and three anti-collapse grids; this co-located test keeps
 * `@balo/shared`'s own coverage honest in isolation and pins the input guards.
 */
describe('resolveSessionOverdraftShare', () => {
  it('in credit ⇒ nothing to settle', () => {
    expect(
      resolveSessionOverdraftShare({ walletBalanceMinor: 500, ownConsumedMinor: 1_000 })
    ).toEqual({
      overdraftMinor: 0,
      walletNegativeMinor: 0,
      ownConsumedMinor: 1_000,
      priorDebtLeftMinor: 0,
    });
  });

  it('exactly zero ⇒ nothing to settle (and no negative zero)', () => {
    const share = resolveSessionOverdraftShare({ walletBalanceMinor: 0, ownConsumedMinor: 0 });
    expect(Object.is(share.overdraftMinor, 0)).toBe(true);
    expect(Object.is(share.walletNegativeMinor, 0)).toBe(true);
  });

  it('a clean overrun settles the whole negative balance — the legacy figure', () => {
    expect(
      resolveSessionOverdraftShare({ walletBalanceMinor: -400, ownConsumedMinor: 1_000 })
    ).toMatchObject({ overdraftMinor: 400, priorDebtLeftMinor: 0 });
  });

  it('older debt on the wallet is capped out — WE1: 17,500 of 27,500, leaving 10,000 prior', () => {
    expect(
      resolveSessionOverdraftShare({ walletBalanceMinor: -27_500, ownConsumedMinor: 17_500 })
    ).toEqual({
      overdraftMinor: 17_500,
      walletNegativeMinor: 27_500,
      ownConsumedMinor: 17_500,
      priorDebtLeftMinor: 10_000,
    });
  });

  it('a session that consumed nothing settles nothing, however far the wallet is below zero', () => {
    expect(
      resolveSessionOverdraftShare({ walletBalanceMinor: -50_000, ownConsumedMinor: 0 })
    ).toMatchObject({ overdraftMinor: 0, priorDebtLeftMinor: 50_000 });
  });

  it('rejects a non-integer balance', () => {
    expect(() =>
      resolveSessionOverdraftShare({ walletBalanceMinor: 1.5, ownConsumedMinor: 0 })
    ).toThrow(/walletBalanceMinor must be an integer/);
    expect(() =>
      resolveSessionOverdraftShare({
        walletBalanceMinor: Number.POSITIVE_INFINITY,
        ownConsumedMinor: 0,
      })
    ).toThrow(/integer/);
  });

  it('rejects a non-integer or negative own consumption', () => {
    expect(() =>
      resolveSessionOverdraftShare({ walletBalanceMinor: -1, ownConsumedMinor: 0.5 })
    ).toThrow(/ownConsumedMinor must be an integer/);
    expect(() =>
      resolveSessionOverdraftShare({ walletBalanceMinor: -1, ownConsumedMinor: -700 })
    ).toThrow(/must not be negative/);
  });
});
