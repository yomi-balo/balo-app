import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockEarliestAnchor, mockSumPromo } = vi.hoisted(() => ({
  mockEarliestAnchor: vi.fn(),
  mockSumPromo: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  creditReceivablesRepository: { earliestOpenDebtAnchor: mockEarliestAnchor },
  creditLedgerRepository: { sumPromoGrantedSince: mockSumPromo },
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
}));

import { assessCashCoverage } from './receivable-coverage.js';

/** The caller's transaction handle — opaque here; only its pass-through is asserted. */
const tx = {} as Parameters<typeof assessCashCoverage>[0];

describe('assessCashCoverage (BAL-535 fix round B1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('short-circuits when the wallet has no open receivable — and never asks about promo', async () => {
    mockEarliestAnchor.mockResolvedValue(undefined);
    const verdict = await assessCashCoverage(tx, 'wallet_1', 17_600);
    expect(verdict).toEqual({
      hasOpenReceivable: false,
      covered: false,
      balanceMinor: 17_600,
      promoGrantedSinceDebtMinor: 0,
      cashBackedBalanceMinor: 17_600,
    });
    expect(mockSumPromo).not.toHaveBeenCalled();
  });

  it('covers when the balance is non-negative and no promo landed since the debt opened', async () => {
    mockEarliestAnchor.mockResolvedValue(new Date('2026-09-01T00:00:00Z'));
    mockSumPromo.mockResolvedValue(0);
    const verdict = await assessCashCoverage(tx, 'wallet_1', 0);
    expect(verdict.hasOpenReceivable).toBe(true);
    expect(verdict.covered).toBe(true);
    expect(verdict.cashBackedBalanceMinor).toBe(0);
  });

  it('⚠⚠ B1 — a promo granted SINCE the debt opened does not cover it (a cent of cash + $50 promo)', async () => {
    mockEarliestAnchor.mockResolvedValue(new Date('2026-09-01T00:00:00Z'));
    mockSumPromo.mockResolvedValue(5_000);
    const verdict = await assessCashCoverage(tx, 'wallet_1', 1);
    expect(verdict.covered).toBe(false);
    expect(verdict.promoGrantedSinceDebtMinor).toBe(5_000);
    expect(verdict.cashBackedBalanceMinor).toBe(-4_999);
  });

  it('⚠⚠ B1 — cash on TOP of the promo still covers', async () => {
    mockEarliestAnchor.mockResolvedValue(new Date('2026-09-01T00:00:00Z'));
    mockSumPromo.mockResolvedValue(5_000);
    const verdict = await assessCashCoverage(tx, 'wallet_1', 5_000);
    expect(verdict.covered).toBe(true);
    expect(verdict.cashBackedBalanceMinor).toBe(0);
  });

  it('a partial top-up that leaves the balance negative never covers', async () => {
    mockEarliestAnchor.mockResolvedValue(new Date('2026-09-01T00:00:00Z'));
    mockSumPromo.mockResolvedValue(0);
    const verdict = await assessCashCoverage(tx, 'wallet_1', -100);
    expect(verdict.covered).toBe(false);
  });

  it("rides the CALLER'S transaction on both reads — never a bare db", async () => {
    const anchor = new Date('2026-09-01T00:00:00Z');
    mockEarliestAnchor.mockResolvedValue(anchor);
    mockSumPromo.mockResolvedValue(0);
    await assessCashCoverage(tx, 'wallet_9', 10);
    expect(mockEarliestAnchor).toHaveBeenCalledWith('wallet_9', tx);
    expect(mockSumPromo).toHaveBeenCalledWith({ walletId: 'wallet_9', since: anchor }, tx);
  });
});
