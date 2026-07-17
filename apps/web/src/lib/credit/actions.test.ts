import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockFindByCompanyId = vi.fn();
const mockUpdateConfig = vi.fn();
const mockValidate = vi.fn();
vi.mock('@balo/db', () => ({
  creditWalletsRepository: {
    findByCompanyId: (...a: unknown[]) => mockFindByCompanyId(...a),
    updateConfig: (...a: unknown[]) => mockUpdateConfig(...a),
  },
  promoRedemptionsRepository: {
    validate: (...a: unknown[]) => mockValidate(...a),
  },
}));

const mockRequireUser = vi.fn();
const mockGetCompanyContext = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: (...a: unknown[]) => mockRequireUser(...a),
  getCompanyContext: (...a: unknown[]) => mockGetCompanyContext(...a),
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { MANAGE_BILLING: 'manage_billing' },
}));

const mockLogError = vi.fn();
vi.mock('@/lib/logging', () => ({
  log: { error: (...a: unknown[]) => mockLogError(...a), warn: vi.fn(), info: vi.fn() },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublish(...a),
}));

const mockCreatePurchaseIntent = vi.fn();
const mockCreateMandateSetupIntent = vi.fn();
vi.mock('./api-client', () => ({
  createPurchaseIntent: (...a: unknown[]) => mockCreatePurchaseIntent(...a),
  createMandateSetupIntent: (...a: unknown[]) => mockCreateMandateSetupIntent(...a),
}));

import {
  startPurchaseAction,
  validatePromoAction,
  saveLowBalanceConfigAction,
  nudgeBillingAdminAction,
  type StartPurchaseInput,
} from './actions';

const CLIENT_REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function baseStartInput(overrides: Partial<StartPurchaseInput> = {}): StartPurchaseInput {
  return {
    amountMinor: 100_000,
    clientRequestId: CLIENT_REQUEST_ID,
    config: { lowBalanceMode: 'keep_going', topupReloadMinor: 30_000, topupThresholdMinor: 5_000 },
    ...overrides,
  };
}

describe('credit actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue({ id: 'user-1' });
    mockGetCompanyContext.mockResolvedValue({ companyId: 'company-1' });
    mockHasCapability.mockResolvedValue(true);
    mockFindByCompanyId.mockResolvedValue({ id: 'wallet-1', balanceMinor: 0 });
    mockCreatePurchaseIntent.mockResolvedValue({
      clientSecret: 'pi_secret',
      paymentIntentId: 'pi_1',
    });
    mockCreateMandateSetupIntent.mockResolvedValue({ clientSecret: 'seti_secret' });
    mockPublish.mockResolvedValue(undefined);
  });

  describe('startPurchaseAction', () => {
    it('gates on MANAGE_BILLING', async () => {
      mockHasCapability.mockResolvedValue(false);
      const res = await startPurchaseAction(baseStartInput());
      expect(res).toEqual({ ok: false, error: 'unauthorized' });
      expect(mockCreatePurchaseIntent).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range amount as invalid_input', async () => {
      const res = await startPurchaseAction(baseStartInput({ amountMinor: 1 }));
      expect(res).toEqual({ ok: false, error: 'invalid_input' });
    });

    it('returns no_wallet when the company has no wallet', async () => {
      mockFindByCompanyId.mockResolvedValue(undefined);
      const res = await startPurchaseAction(baseStartInput());
      expect(res).toEqual({ ok: false, error: 'no_wallet' });
    });

    it('persists config, creates BOTH intents for a card-backed mode, and returns both secrets', async () => {
      const res = await startPurchaseAction(baseStartInput());
      expect(res).toEqual({
        ok: true,
        clientSecret: 'pi_secret',
        paymentIntentId: 'pi_1',
        setupClientSecret: 'seti_secret',
        walletId: 'wallet-1',
      });
      expect(mockUpdateConfig).toHaveBeenCalledWith('wallet-1', { lowBalanceMode: 'keep_going' });
      expect(mockCreateMandateSetupIntent).toHaveBeenCalledWith('wallet-1');
    });

    it('skips the SetupIntent when the wallet already has an ACTIVE mandate (no downgrade)', async () => {
      mockFindByCompanyId.mockResolvedValue({
        id: 'wallet-1',
        balanceMinor: 0,
        mandateStatus: 'active',
      });
      const res = await startPurchaseAction(baseStartInput());
      expect(res).toMatchObject({ ok: true, setupClientSecret: null });
      expect(mockCreateMandateSetupIntent).not.toHaveBeenCalled();
    });

    it('omits the SetupIntent for notify_only (no mandate)', async () => {
      const res = await startPurchaseAction(
        baseStartInput({
          config: {
            lowBalanceMode: 'notify_only',
            topupReloadMinor: 30_000,
            topupThresholdMinor: 5_000,
          },
        })
      );
      expect(res).toMatchObject({ ok: true, setupClientSecret: null });
      expect(mockCreateMandateSetupIntent).not.toHaveBeenCalled();
    });

    it('writes reload/threshold for auto_topup', async () => {
      await startPurchaseAction(
        baseStartInput({
          config: {
            lowBalanceMode: 'auto_topup',
            topupReloadMinor: 40_000,
            topupThresholdMinor: 10_000,
          },
        })
      );
      expect(mockUpdateConfig).toHaveBeenCalledWith('wallet-1', {
        lowBalanceMode: 'auto_topup',
        topupReloadMinor: 40_000,
        topupThresholdMinor: 10_000,
      });
    });

    it('logs and returns stripe_error when intent creation throws', async () => {
      mockCreatePurchaseIntent.mockRejectedValue(new Error('stripe down'));
      const res = await startPurchaseAction(baseStartInput());
      expect(res).toEqual({ ok: false, error: 'stripe_error' });
      expect(mockLogError).toHaveBeenCalled();
    });
  });

  describe('validatePromoAction', () => {
    it('gates on MANAGE_BILLING', async () => {
      mockHasCapability.mockResolvedValue(false);
      expect(await validatePromoAction('X')).toEqual({ ok: false, reason: 'unauthorized' });
    });

    it('returns the grant on a valid code', async () => {
      mockValidate.mockResolvedValue({ ok: true, promoCodeId: 'p1', grantMinor: 5_000 });
      expect(await validatePromoAction('WELCOME50')).toEqual({ ok: true, grantMinor: 5_000 });
    });

    it('passes through the specific failure reason', async () => {
      mockValidate.mockResolvedValue({ ok: false, reason: 'expired' });
      expect(await validatePromoAction('OLD')).toEqual({ ok: false, reason: 'expired' });
    });

    it('logs and returns error on an unexpected throw', async () => {
      mockValidate.mockRejectedValue(new Error('db down'));
      expect(await validatePromoAction('X')).toEqual({ ok: false, reason: 'error' });
      expect(mockLogError).toHaveBeenCalled();
    });
  });

  describe('saveLowBalanceConfigAction', () => {
    it('rejects reload < threshold for auto_topup as invalid_input', async () => {
      const res = await saveLowBalanceConfigAction({
        lowBalanceMode: 'auto_topup',
        topupReloadMinor: 5_000,
        topupThresholdMinor: 30_000,
      });
      expect(res).toEqual({ ok: false, error: 'invalid_input' });
    });

    it('gates on MANAGE_BILLING', async () => {
      mockHasCapability.mockResolvedValue(false);
      const res = await saveLowBalanceConfigAction({
        lowBalanceMode: 'notify_only',
        topupReloadMinor: 30_000,
        topupThresholdMinor: 5_000,
      });
      expect(res).toEqual({ ok: false, error: 'unauthorized' });
    });

    it('persists valid config', async () => {
      const res = await saveLowBalanceConfigAction({
        lowBalanceMode: 'notify_only',
        topupReloadMinor: 30_000,
        topupThresholdMinor: 5_000,
      });
      expect(res).toEqual({ ok: true });
      expect(mockUpdateConfig).toHaveBeenCalled();
    });
  });

  describe('nudgeBillingAdminAction', () => {
    it('publishes credit.topup.requested without a MANAGE_BILLING gate', async () => {
      const res = await nudgeBillingAdminAction();
      expect(res).toEqual({ ok: true });
      expect(mockHasCapability).not.toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalledWith(
        'credit.topup.requested',
        expect.objectContaining({ companyId: 'company-1', requestedByUserId: 'user-1' })
      );
    });

    it('window-buckets the correlationId so repeat nudges dedup within the hour', async () => {
      await nudgeBillingAdminAction();
      await nudgeBillingAdminAction();
      const first = mockPublish.mock.calls[0]?.[1] as { correlationId: string };
      const second = mockPublish.mock.calls[1]?.[1] as { correlationId: string };
      expect(first.correlationId).toMatch(/^topup-nudge:company-1:user-1:\d+$/);
      // Same (company, user, hour) → identical id → the engine's jobId dedups the repeat.
      expect(second.correlationId).toBe(first.correlationId);
    });

    it('logs and returns error on a publish throw', async () => {
      mockPublish.mockRejectedValue(new Error('queue down'));
      expect(await nudgeBillingAdminAction()).toEqual({ ok: false, error: 'error' });
      expect(mockLogError).toHaveBeenCalled();
    });
  });
});
