import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockAcquireWalletLock,
  mockFindWallet,
  mockSetPendingTopupAt,
  mockHasActiveSession,
  mockHasOpenReceivable,
  mockGetLatestEntryId,
  mockCreateOffSessionCharge,
  mockPublish,
  mockTrackServer,
} = vi.hoisted(() => ({
  mockAcquireWalletLock: vi.fn(),
  mockFindWallet: vi.fn(),
  mockSetPendingTopupAt: vi.fn(),
  mockHasActiveSession: vi.fn(),
  mockHasOpenReceivable: vi.fn(),
  mockGetLatestEntryId: vi.fn(),
  mockCreateOffSessionCharge: vi.fn(),
  mockPublish: vi.fn(),
  mockTrackServer: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  acquireWalletLock: mockAcquireWalletLock,
  creditWalletsRepository: { findById: mockFindWallet, setPendingTopupAt: mockSetPendingTopupAt },
  creditSessionsRepository: { hasActiveSessionForWallet: mockHasActiveSession },
  creditReceivablesRepository: { hasOpenReceivable: mockHasOpenReceivable },
  creditLedgerRepository: { getLatestEntryId: mockGetLatestEntryId },
  deriveIdempotencyKey: (input: { walletId: string; triggeringEntryId: string }) =>
    `auto_topup:${input.walletId}:${input.triggeringEntryId}`,
  db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
}));
vi.mock('../stripe/charges.js', () => ({ createOffSessionCharge: mockCreateOffSessionCharge }));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  CREDIT_SERVER_EVENTS: {
    AUTO_TOPUP_FIRED: 'credit_auto_topup_fired',
    AUTO_TOPUP_FAILED: 'credit_auto_topup_failed',
  },
}));

import {
  evaluateAutoTopup,
  publishAutoTopupExecuted,
  publishAutoTopupFailed,
  triggerAutoTopupBestEffort,
} from './auto-topup.js';

/** Below-threshold, auto_topup, valid mandate, non-negative, no in-flight marker — happy fixture. */
const WALLET = {
  id: 'wallet_1',
  companyId: 'company_1',
  lowBalanceMode: 'auto_topup',
  mandateStatus: 'active',
  stripeCustomerId: 'cus_1',
  stripePaymentMethodId: 'pm_1',
  balanceMinor: 1000,
  topupThresholdMinor: 2000,
  topupReloadMinor: 10_000,
  pendingTopupAt: null,
  expiresAt: null,
};

const EXPECTED_KEY = 'auto_topup:wallet_1:led_E';
const TTL_MS = 15 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  mockAcquireWalletLock.mockResolvedValue(undefined);
  mockFindWallet.mockResolvedValue({ ...WALLET });
  mockSetPendingTopupAt.mockResolvedValue(undefined);
  mockHasActiveSession.mockResolvedValue(false);
  mockHasOpenReceivable.mockResolvedValue(false);
  mockGetLatestEntryId.mockResolvedValue('led_E');
  mockCreateOffSessionCharge.mockResolvedValue({ status: 'processing', paymentIntentId: 'pi_1' });
  mockPublish.mockResolvedValue(undefined);
});

describe('evaluateAutoTopup — guard sequence (does not fire)', () => {
  it('skips mode_off when lowBalanceMode !== auto_topup', async () => {
    mockFindWallet.mockResolvedValue({ ...WALLET, lowBalanceMode: 'notify_only' });
    const out = await evaluateAutoTopup('wallet_1');
    expect(out).toEqual({ outcome: 'skipped', reason: 'mode_off' });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('skips wallet_missing when the wallet is absent', async () => {
    mockFindWallet.mockResolvedValue(undefined);
    const out = await evaluateAutoTopup('wallet_1');
    expect(out).toEqual({ outcome: 'skipped', reason: 'wallet_missing' });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('skips no_mandate when the mandate is not active', async () => {
    mockFindWallet.mockResolvedValue({ ...WALLET, mandateStatus: 'failed' });
    const out = await evaluateAutoTopup('wallet_1');
    expect(out).toEqual({ outcome: 'skipped', reason: 'no_mandate' });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('skips no_mandate when the customer id is missing', async () => {
    mockFindWallet.mockResolvedValue({ ...WALLET, stripeCustomerId: null });
    const out = await evaluateAutoTopup('wallet_1');
    expect(out).toEqual({ outcome: 'skipped', reason: 'no_mandate' });
  });

  it('skips no_mandate when the payment method id is missing', async () => {
    mockFindWallet.mockResolvedValue({ ...WALLET, stripePaymentMethodId: null });
    const out = await evaluateAutoTopup('wallet_1');
    expect(out).toEqual({ outcome: 'skipped', reason: 'no_mandate' });
  });

  it('skips above_threshold when balance >= threshold', async () => {
    mockFindWallet.mockResolvedValue({ ...WALLET, balanceMinor: 2000 });
    const out = await evaluateAutoTopup('wallet_1');
    expect(out).toEqual({ outcome: 'skipped', reason: 'above_threshold' });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('skips active_or_held when a session is active', async () => {
    mockHasActiveSession.mockResolvedValue(true);
    const out = await evaluateAutoTopup('wallet_1');
    expect(out).toEqual({ outcome: 'skipped', reason: 'active_or_held' });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('skips active_or_held when a receivable is open', async () => {
    mockHasOpenReceivable.mockResolvedValue(true);
    const out = await evaluateAutoTopup('wallet_1');
    expect(out).toEqual({ outcome: 'skipped', reason: 'active_or_held' });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('skips active_or_held when the balance is negative (unsettled overdraft)', async () => {
    mockFindWallet.mockResolvedValue({ ...WALLET, balanceMinor: -500 });
    const out = await evaluateAutoTopup('wallet_1');
    expect(out).toEqual({ outcome: 'skipped', reason: 'active_or_held' });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('skips no_ledger_entry when the wallet has no ledger history', async () => {
    mockGetLatestEntryId.mockResolvedValue(undefined);
    const out = await evaluateAutoTopup('wallet_1');
    expect(out).toEqual({ outcome: 'skipped', reason: 'no_ledger_entry' });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('skips topup_in_flight when a FRESH pending marker is set (single-in-flight)', async () => {
    mockFindWallet.mockResolvedValue({ ...WALLET, pendingTopupAt: new Date() });
    const out = await evaluateAutoTopup('wallet_1');
    expect(out).toEqual({ outcome: 'skipped', reason: 'topup_in_flight' });
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
    // A skip must NOT (re-)arm the marker.
    expect(mockSetPendingTopupAt).not.toHaveBeenCalled();
  });

  it('PROCEEDS when the pending marker is STALE (older than the TTL — lost webhook, self-heals)', async () => {
    mockFindWallet.mockResolvedValue({
      ...WALLET,
      pendingTopupAt: new Date(Date.now() - TTL_MS - 60_000),
    });
    const out = await evaluateAutoTopup('wallet_1');
    expect(out).toMatchObject({ outcome: 'charged' });
    expect(mockCreateOffSessionCharge).toHaveBeenCalledTimes(1);
  });
});

describe('evaluateAutoTopup — charge path', () => {
  it('charges once with the crossing key + AUD reload amount; notifies/analytics NOTHING on processing', async () => {
    const out = await evaluateAutoTopup('wallet_1');

    expect(mockCreateOffSessionCharge).toHaveBeenCalledTimes(1);
    expect(mockCreateOffSessionCharge).toHaveBeenCalledWith({
      reason: 'auto_topup',
      walletId: 'wallet_1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      currency: 'aud',
      amountMinor: 10_000,
      idempotencyKey: EXPECTED_KEY,
      triggeringEntryId: 'led_E',
    });
    expect(out).toEqual({
      outcome: 'charged',
      paymentIntentId: 'pi_1',
      triggeringEntryId: 'led_E',
      reloadMinor: 10_000,
    });
    // The credit + executed notice + analytics arrive via the webhook, NOT the engine.
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
    // Phase 1 ARMED the in-flight marker (a Date, under the tx); processing LEAVES it set —
    // the webhook clears it, so the engine must NOT clear it here.
    expect(mockSetPendingTopupAt).toHaveBeenCalledTimes(1);
    const [armWallet, armAt] = mockSetPendingTopupAt.mock.calls[0] ?? [];
    expect(armWallet).toBe('wallet_1');
    expect(armAt).toBeInstanceOf(Date);
    expect(mockSetPendingTopupAt).not.toHaveBeenCalledWith('wallet_1', null);
  });

  it('two evaluations of the same crossing pass the IDENTICAL idempotency key (Stripe collapses to one charge)', async () => {
    await evaluateAutoTopup('wallet_1');
    await evaluateAutoTopup('wallet_1');
    const [first, second] = mockCreateOffSessionCharge.mock.calls;
    expect(first?.[0].idempotencyKey).toBe(EXPECTED_KEY);
    expect(second?.[0].idempotencyKey).toBe(first?.[0].idempotencyKey);
  });

  it('acquires the wallet lock BEFORE reading the wallet (Phase 1 under the lock)', async () => {
    await evaluateAutoTopup('wallet_1');
    expect(mockAcquireWalletLock).toHaveBeenCalledTimes(1);
    const lockOrder = mockAcquireWalletLock.mock.invocationCallOrder[0] ?? Infinity;
    const readOrder = mockFindWallet.mock.invocationCallOrder[0] ?? -Infinity;
    expect(lockOrder).toBeLessThan(readOrder);
  });
});

describe('evaluateAutoTopup — failure routing', () => {
  it('requires_action → publishes the failed notice with analytics; returns failed', async () => {
    mockCreateOffSessionCharge.mockResolvedValue({
      status: 'requires_action',
      paymentIntentId: 'pi_sca',
      clientSecret: 'cs_1',
    });

    const out = await evaluateAutoTopup('wallet_1');

    expect(out).toEqual({
      outcome: 'failed',
      reason: 'requires_action',
      triggeringEntryId: 'led_E',
    });
    expect(mockPublish).toHaveBeenCalledWith('credit.auto_topup.failed', {
      correlationId: `${EXPECTED_KEY}:failed`,
      walletId: 'wallet_1',
      companyId: 'company_1',
      reason: 'requires_action',
      attemptedMinor: 10_000,
    });
    expect(mockTrackServer).toHaveBeenCalledWith('credit_auto_topup_failed', {
      amount_minor: 10_000,
      trigger_balance_minor: 1000,
      failure_reason: 'requires_action',
      company_id: 'company_1',
      wallet_id: 'wallet_1',
      distinct_id: 'company_1',
    });
    // A definite non-completion → the in-flight marker is CLEARED (unblock future reloads).
    expect(mockSetPendingTopupAt).toHaveBeenCalledWith('wallet_1', null);
  });

  it('hard CARD decline → clears the marker, publishes the failed notice + analytics; SWALLOWS', async () => {
    // A genuine card decline carries Stripe's `type: 'card_error'` (the only DEFINITE failure).
    const declineError = Object.assign(new Error('Your card was declined.'), {
      type: 'card_error',
      code: 'card_declined',
    });
    mockCreateOffSessionCharge.mockRejectedValue(declineError);

    // Must RESOLVE (never reject) — best-effort must not break the settlement path.
    const out = await evaluateAutoTopup('wallet_1');

    expect(out).toEqual({ outcome: 'failed', reason: 'declined', triggeringEntryId: 'led_E' });
    expect(mockSetPendingTopupAt).toHaveBeenCalledWith('wallet_1', null);
    expect(mockPublish).toHaveBeenCalledWith('credit.auto_topup.failed', {
      correlationId: `${EXPECTED_KEY}:failed`,
      walletId: 'wallet_1',
      companyId: 'company_1',
      reason: 'declined',
      attemptedMinor: 10_000,
    });
    expect(mockTrackServer).toHaveBeenCalledWith('credit_auto_topup_failed', {
      amount_minor: 10_000,
      trigger_balance_minor: 1000,
      failure_reason: 'declined',
      failure_code: 'card_declined',
      company_id: 'company_1',
      wallet_id: 'wallet_1',
      distinct_id: 'company_1',
    });
  });

  it('INDETERMINATE (non-card) error → NO notice, NO analytics, marker LEFT set; returns indeterminate', async () => {
    // A connection/api/rate-limit/idempotency error — the PI may have succeeded, so the webhook is
    // authoritative. NOT a card_error.
    const indeterminate = Object.assign(new Error('connection error'), {
      type: 'api_connection_error',
    });
    mockCreateOffSessionCharge.mockRejectedValue(indeterminate);

    const out = await evaluateAutoTopup('wallet_1');

    expect(out).toEqual({ outcome: 'indeterminate', triggeringEntryId: 'led_E' });
    // No customer-facing failure, no analytics.
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
    // The marker is only ARMED in Phase 1 (a Date) and NEVER cleared — leave it for the webhook/TTL.
    expect(mockSetPendingTopupAt).not.toHaveBeenCalledWith('wallet_1', null);
  });
});

describe('publishAutoTopupExecuted', () => {
  it('emits AUTO_TOPUP_FIRED + publishes the executed notice keyed on the crossing', async () => {
    await publishAutoTopupExecuted({
      walletId: 'wallet_1',
      companyId: 'company_1',
      triggeringEntryId: 'led_E',
      reloadedMinor: 10_000,
      triggerBalanceMinor: 1000,
      balanceAfterMinor: 11_000,
      expiresAt: '2028-01-01T00:00:00.000Z',
    });

    expect(mockTrackServer).toHaveBeenCalledWith('credit_auto_topup_fired', {
      amount_minor: 10_000,
      trigger_balance_minor: 1000,
      company_id: 'company_1',
      wallet_id: 'wallet_1',
      distinct_id: 'company_1',
    });
    expect(mockPublish).toHaveBeenCalledWith('credit.auto_topup.executed', {
      correlationId: EXPECTED_KEY,
      walletId: 'wallet_1',
      companyId: 'company_1',
      reloadedMinor: 10_000,
      balanceAfterMinor: 11_000,
      expiresAt: '2028-01-01T00:00:00.000Z',
    });
  });

  it('swallows a publish failure (money committed; notification best-effort)', async () => {
    mockPublish.mockRejectedValue(new Error('redis down'));
    await expect(
      publishAutoTopupExecuted({
        walletId: 'wallet_1',
        companyId: 'company_1',
        triggeringEntryId: 'led_E',
        reloadedMinor: 10_000,
        triggerBalanceMinor: 1000,
        balanceAfterMinor: 11_000,
        expiresAt: '',
      })
    ).resolves.toBeUndefined();
  });
});

describe('triggerAutoTopupBestEffort', () => {
  it('swallows a Phase-1 fault (a lock/DB throw never propagates to the caller)', async () => {
    mockAcquireWalletLock.mockRejectedValue(new Error('db down'));
    await expect(triggerAutoTopupBestEffort('wallet_1', { op: 'test' })).resolves.toBeUndefined();
    expect(mockCreateOffSessionCharge).not.toHaveBeenCalled();
  });

  it('drives evaluateAutoTopup on the happy path', async () => {
    await triggerAutoTopupBestEffort('wallet_1', { op: 'test' });
    expect(mockCreateOffSessionCharge).toHaveBeenCalledTimes(1);
  });
});

describe('publishAutoTopupFailed', () => {
  it('with emitAnalytics=false publishes the notice but emits NO analytics (async recovery belt)', async () => {
    await publishAutoTopupFailed({
      walletId: 'wallet_1',
      companyId: 'company_1',
      triggeringEntryId: 'led_E',
      reason: 'declined',
      attemptedMinor: 10_000,
      triggerBalanceMinor: 1000,
      emitAnalytics: false,
    });

    expect(mockPublish).toHaveBeenCalledWith('credit.auto_topup.failed', {
      correlationId: `${EXPECTED_KEY}:failed`,
      walletId: 'wallet_1',
      companyId: 'company_1',
      reason: 'declined',
      attemptedMinor: 10_000,
    });
    expect(mockTrackServer).not.toHaveBeenCalled();
  });
});
