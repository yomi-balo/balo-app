import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-474 (plan §I.7, V1-F2 / V4-F8) — `bookingFundingRepository.readSnapshot`'s ISOLATION,
 * proved where it can be seen.
 *
 * ⚠ WHY A UNIT TEST. Under the single-connection integration harness a nested `transaction()` is
 * a SAVEPOINT that silently drops the isolation config (`setup-integration.ts`; drizzle's
 * postgres-js session), so no ordinary integration test can observe that the snapshot is one
 * `REPEATABLE READ, READ ONLY` transaction — or that EVERY read (the holds sum included) runs on
 * that transaction's executor rather than a second pooled connection. Both are identity claims
 * about the arguments, and only a mock can make them. The two-connection proof that the isolation
 * actually holds is `booking-funding.concurrency.integration.test.ts`; the behaviour of each read
 * is `booking-funding.integration.test.ts`.
 */

const TX = { name: 'the-snapshot-transaction' };

const {
  mockTransaction,
  mockFindByCompanyId,
  mockReadHoldStatus,
  mockFindRateCentsById,
  mockGetAvailableForBooking,
  mockListReservableCaseBookings,
} = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockFindByCompanyId: vi.fn(),
  mockReadHoldStatus: vi.fn(),
  mockFindRateCentsById: vi.fn(),
  mockGetAvailableForBooking: vi.fn(),
  mockListReservableCaseBookings: vi.fn(),
}));

vi.mock('../client', () => ({
  db: { transaction: (fn: unknown, config: unknown) => mockTransaction(fn, config) },
}));
vi.mock('./credit-wallets', () => ({
  creditWalletsRepository: { findByCompanyId: mockFindByCompanyId },
}));
vi.mock('./credit-receivables', () => ({
  creditReceivablesRepository: { readHoldStatus: mockReadHoldStatus },
}));
vi.mock('./experts', () => ({
  expertsRepository: { findRateCentsById: mockFindRateCentsById },
}));
vi.mock('./credit-holds', () => ({
  creditHoldsRepository: { getAvailableForBooking: mockGetAvailableForBooking },
}));
vi.mock('./meetings', () => ({
  meetingsRepository: { listReservableCaseBookings: mockListReservableCaseBookings },
}));

import { bookingFundingRepository } from './booking-funding';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const EXPERT_ID = '22222222-2222-4222-8222-222222222222';
const WALLET_ID = '33333333-3333-4333-8333-333333333333';
const NOT_ON_HOLD = {
  onHold: false,
  openReceivableCount: 0,
  confirmationWasRequested: false,
  balanceMinor: 30_000,
  promoGrantedSinceDebtMinor: 0,
  amountToClearMinor: 0,
};

function wallet(mandateStatus: string | null): Record<string, unknown> {
  return {
    id: WALLET_ID,
    companyId: COMPANY_ID,
    balanceMinor: 30_000,
    mandateStatus,
    stripeCustomerId: mandateStatus === null ? null : 'cus_x',
    stripePaymentMethodId: mandateStatus === null ? null : 'pm_x',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(TX));
  mockFindByCompanyId.mockResolvedValue(wallet(null));
  mockReadHoldStatus.mockResolvedValue(NOT_ON_HOLD);
  mockFindRateCentsById.mockResolvedValue({ rateCents: 33_600 });
  mockGetAvailableForBooking.mockResolvedValue(30_000);
  mockListReservableCaseBookings.mockResolvedValue([]);
});

describe('bookingFundingRepository.readSnapshot — one snapshot', () => {
  it('runs in ONE repeatable-read, read-only transaction', async () => {
    const now = new Date();
    await bookingFundingRepository.readSnapshot({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_ID,
      now,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  });

  it('EVERY read — the holds sum included — receives that transaction as its executor', async () => {
    const now = new Date();
    const snapshot = await bookingFundingRepository.readSnapshot({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_ID,
      now,
    });
    expect(snapshot).toEqual({
      kind: 'no_mandate',
      walletId: WALLET_ID,
      expertRateCents: 33_600,
      availableMinor: 30_000,
      reservable: [],
    });
    expect(mockFindByCompanyId).toHaveBeenCalledWith(COMPANY_ID, TX);
    expect(mockReadHoldStatus).toHaveBeenCalledWith({ walletId: WALLET_ID }, TX);
    expect(mockFindRateCentsById).toHaveBeenCalledWith(EXPERT_ID, TX);
    expect(mockGetAvailableForBooking).toHaveBeenCalledWith(WALLET_ID, TX);
    expect(mockListReservableCaseBookings).toHaveBeenCalledWith({ companyId: COMPANY_ID, now }, TX);
  });

  it('reads the hold BEFORE the mandate, and a live mandate short-circuits every read below it', async () => {
    mockFindByCompanyId.mockResolvedValue(wallet('active'));
    const snapshot = await bookingFundingRepository.readSnapshot({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_ID,
      now: new Date(),
    });
    expect(snapshot).toEqual({ kind: 'mandate', walletId: WALLET_ID });
    expect(mockReadHoldStatus).toHaveBeenCalledTimes(1);
    expect(mockFindRateCentsById).not.toHaveBeenCalled();
    expect(mockGetAvailableForBooking).not.toHaveBeenCalled();
    expect(mockListReservableCaseBookings).not.toHaveBeenCalled();
  });

  it('an open hold is returned before the mandate is consulted — the brake binds a mandate holder', async () => {
    const hold = { ...NOT_ON_HOLD, onHold: true, openReceivableCount: 1, amountToClearMinor: 500 };
    mockFindByCompanyId.mockResolvedValue(wallet('active'));
    mockReadHoldStatus.mockResolvedValue(hold);
    const snapshot = await bookingFundingRepository.readSnapshot({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_ID,
      now: new Date(),
    });
    expect(snapshot).toEqual({ kind: 'on_hold', walletId: WALLET_ID, hold });
    expect(mockFindRateCentsById).not.toHaveBeenCalled();
  });

  it('no wallet ⇒ no_wallet, and nothing else is read', async () => {
    mockFindByCompanyId.mockResolvedValue(undefined);
    const snapshot = await bookingFundingRepository.readSnapshot({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_ID,
      now: new Date(),
    });
    expect(snapshot).toEqual({ kind: 'no_wallet' });
    expect(mockReadHoldStatus).not.toHaveBeenCalled();
  });

  it('an unknown expert ⇒ unknown_expert (fail closed), before any balance read', async () => {
    mockFindRateCentsById.mockResolvedValue(undefined);
    const snapshot = await bookingFundingRepository.readSnapshot({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_ID,
      now: new Date(),
    });
    expect(snapshot).toEqual({ kind: 'unknown_expert', walletId: WALLET_ID });
    expect(mockGetAvailableForBooking).not.toHaveBeenCalled();
  });
});

describe('bookingFundingRepository.readCardRemovalSnapshot — the D10.6 sibling read', () => {
  it('runs in ONE repeatable-read, read-only transaction, every read on that executor', async () => {
    mockFindByCompanyId.mockResolvedValue(wallet('active'));
    mockListReservableCaseBookings.mockResolvedValue([{ meetingId: 'm-1' }]);
    const now = new Date();

    const snapshot = await bookingFundingRepository.readCardRemovalSnapshot({
      companyId: COMPANY_ID,
      now,
    });

    expect(snapshot).toEqual({
      kind: 'mandate',
      walletId: WALLET_ID,
      availableMinor: 30_000,
      reservable: [{ meetingId: 'm-1' }],
    });
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
    expect(mockFindByCompanyId).toHaveBeenCalledWith(COMPANY_ID, TX);
    expect(mockGetAvailableForBooking).toHaveBeenCalledWith(WALLET_ID, TX);
    expect(mockListReservableCaseBookings).toHaveBeenCalledWith({ companyId: COMPANY_ID, now }, TX);
  });

  it('a wallet with no active mandate short-circuits — no balance and no bookings are read', async () => {
    mockFindByCompanyId.mockResolvedValue(wallet(null));
    const snapshot = await bookingFundingRepository.readCardRemovalSnapshot({
      companyId: COMPANY_ID,
      now: new Date(),
    });
    expect(snapshot).toEqual({ kind: 'no_mandate', walletId: WALLET_ID });
    expect(mockGetAvailableForBooking).not.toHaveBeenCalled();
    expect(mockListReservableCaseBookings).not.toHaveBeenCalled();
  });

  it('no wallet ⇒ no_wallet, and nothing else is read', async () => {
    mockFindByCompanyId.mockResolvedValue(undefined);
    const snapshot = await bookingFundingRepository.readCardRemovalSnapshot({
      companyId: COMPANY_ID,
      now: new Date(),
    });
    expect(snapshot).toEqual({ kind: 'no_wallet' });
    expect(mockGetAvailableForBooking).not.toHaveBeenCalled();
  });

  it('does not read the hold (detachSavedCard refuses an open receivable before asking) or the expert', async () => {
    mockFindByCompanyId.mockResolvedValue(wallet('active'));
    await bookingFundingRepository.readCardRemovalSnapshot({
      companyId: COMPANY_ID,
      now: new Date(),
    });
    expect(mockReadHoldStatus).not.toHaveBeenCalled();
    expect(mockFindRateCentsById).not.toHaveBeenCalled();
  });
});
