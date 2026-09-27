import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockEarliestAnchor, mockSumPromo, mockClearOpenForWallet, mockAuditRecord, mockLogWarn } =
  vi.hoisted(() => ({
    mockEarliestAnchor: vi.fn(),
    mockSumPromo: vi.fn(),
    mockClearOpenForWallet: vi.fn(),
    mockAuditRecord: vi.fn(),
    mockLogWarn: vi.fn(),
  }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockLogWarn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  creditReceivablesRepository: {
    earliestOpenDebtAnchor: mockEarliestAnchor,
    clearOpenForWallet: mockClearOpenForWallet,
  },
  creditLedgerRepository: { sumPromoGrantedSince: mockSumPromo },
  auditEventsRepository: { record: mockAuditRecord },
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
}));

import { assessCashCoverage, clearCoveredHold } from './receivable-coverage.js';

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

// ── BAL-474 (ADR-1040 Amendment 7 §F, plan §G.2, D7.2) — the HEAL, the fourth hold-releasing site ────

describe('clearCoveredHold (BAL-474 — a covered-but-held wallet is healed under the wallet lock)', () => {
  const ANCHOR = new Date('2026-09-01T00:00:00Z');
  const CLEARED_AT = new Date('2026-09-25T12:00:00Z');

  function row(id: string, amountMinor: number, sessionId = `session_${id}`) {
    return { id, companyId: 'company_1', sessionId, amountMinor, status: 'cleared' };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockEarliestAnchor.mockResolvedValue(ANCHOR);
    mockSumPromo.mockResolvedValue(0);
    mockClearOpenForWallet.mockResolvedValue([row('rcv_1', 10_000)]);
    mockAuditRecord.mockResolvedValue(undefined);
  });

  it('clears every open receivable through the ONE coverage decision, on the caller’s transaction', async () => {
    const result = await clearCoveredHold(tx, {
      walletId: 'wallet_1',
      balanceMinor: 0,
      trigger: 'dunning_claim',
      now: CLEARED_AT,
    });

    expect(mockEarliestAnchor).toHaveBeenCalledWith('wallet_1', tx);
    expect(mockClearOpenForWallet).toHaveBeenCalledWith(
      { walletId: 'wallet_1', now: CLEARED_AT },
      tx
    );
    expect(result).toEqual({
      clearedIds: ['rcv_1'],
      clearedMinor: 10_000,
      companyId: 'company_1',
      balanceMinor: 0,
    });
  });

  it('writes ONE audit row per cleared receivable — a distinct action, actor NULL (a system act), the predicate figures in the metadata', async () => {
    mockClearOpenForWallet.mockResolvedValue([row('rcv_1', 10_000), row('rcv_2', 14_000)]);

    await clearCoveredHold(tx, { walletId: 'wallet_1', balanceMinor: 5, trigger: 'booking_guard' });

    expect(mockAuditRecord).toHaveBeenCalledTimes(2);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      {
        actorUserId: null,
        action: 'credit_receivable.cleared_on_coverage_heal',
        entityType: 'credit_receivable',
        entityId: 'rcv_1',
        metadata: {
          walletId: 'wallet_1',
          companyId: 'company_1',
          sessionId: 'session_rcv_1',
          trigger: 'booking_guard',
          receivableAmountMinor: 10_000,
          predicateBalanceMinor: 5,
          promoDiscountedMinor: 0,
          cashBackedBalanceMinor: 5,
        },
      },
      tx
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'rcv_2' }),
      tx
    );
  });

  it('sums the cleared amounts and logs the heal at WARN (an anomaly worth seeing)', async () => {
    mockClearOpenForWallet.mockResolvedValue([row('rcv_1', 10_000), row('rcv_2', 14_000)]);

    const result = await clearCoveredHold(tx, {
      walletId: 'wallet_1',
      balanceMinor: 0,
      trigger: 'dunning_claim',
    });

    expect(result.clearedMinor).toBe(24_000);
    expect(result.clearedIds).toEqual(['rcv_1', 'rcv_2']);
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'clearCoveredHold',
        walletId: 'wallet_1',
        trigger: 'dunning_claim',
        clearedCount: 2,
        clearedMinor: 24_000,
      }),
      'Covered-but-held wallet healed — the coverage clear had not run'
    );
  });

  it('omits `now` from the clear when the caller passes none (the repository stamps its own)', async () => {
    await clearCoveredHold(tx, { walletId: 'wallet_1', balanceMinor: 0, trigger: 'dunning_claim' });
    expect(mockClearOpenForWallet).toHaveBeenCalledWith({ walletId: 'wallet_1' }, tx);
  });

  it('⚠ a wallet the predicate says is NOT covered heals NOTHING — no clear, no audit, no log', async () => {
    const result = await clearCoveredHold(tx, {
      walletId: 'wallet_1',
      balanceMinor: -1,
      trigger: 'booking_guard',
    });

    expect(result).toEqual({
      clearedIds: [],
      clearedMinor: 0,
      companyId: undefined,
      balanceMinor: -1,
    });
    expect(mockClearOpenForWallet).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('⚠⚠ a PROMO granted since the debt can never heal a hold — the same discount every other site applies', async () => {
    mockSumPromo.mockResolvedValue(5_000);
    const result = await clearCoveredHold(tx, {
      walletId: 'wallet_1',
      balanceMinor: 1,
      trigger: 'booking_guard',
    });
    expect(result.clearedIds).toEqual([]);
    expect(mockClearOpenForWallet).not.toHaveBeenCalled();
  });

  it('a wallet with nothing open heals nothing (the anchor read short-circuits, no promo query)', async () => {
    mockEarliestAnchor.mockResolvedValue(undefined);
    const result = await clearCoveredHold(tx, {
      walletId: 'wallet_1',
      balanceMinor: 100,
      trigger: 'dunning_claim',
    });
    expect(result.clearedIds).toEqual([]);
    expect(mockSumPromo).not.toHaveBeenCalled();
  });

  it('a covered wallet whose receivables another writer cleared first heals nothing and writes no audit row', async () => {
    mockClearOpenForWallet.mockResolvedValue([]);
    const result = await clearCoveredHold(tx, {
      walletId: 'wallet_1',
      balanceMinor: 0,
      trigger: 'booking_guard',
    });
    expect(result).toEqual({
      clearedIds: [],
      clearedMinor: 0,
      companyId: undefined,
      balanceMinor: 0,
    });
    expect(mockAuditRecord).not.toHaveBeenCalled();
  });
});
