import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockEnsureForCompany = vi.fn();
const mockUpdateConfig = vi.fn();
const mockValidate = vi.fn();
vi.mock('@balo/db', () => ({
  db: {},
  creditWalletsRepository: {
    ensureForCompany: (...a: unknown[]) => mockEnsureForCompany(...a),
    updateConfig: (...a: unknown[]) => mockUpdateConfig(...a),
  },
  promoRedemptionsRepository: {
    validate: (...a: unknown[]) => mockValidate(...a),
  },
}));

const mockRequireUser = vi.fn();
const mockGetCompanyContext = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  // The actions authenticate via requireOnboardedUser() (BAL-365 fail-closed gate); both
  // resolve the same session user, so one mock drives both.
  requireUser: (...a: unknown[]) => mockRequireUser(...a),
  requireOnboardedUser: (...a: unknown[]) => mockRequireUser(...a),
  getCompanyContext: (...a: unknown[]) => mockGetCompanyContext(...a),
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { MANAGE_BILLING: 'manage_billing' },
}));

const mockLogError = vi.fn();
const mockLogWarn = vi.fn();
vi.mock('@/lib/logging', () => ({
  log: {
    error: (...a: unknown[]) => mockLogError(...a),
    warn: (...a: unknown[]) => mockLogWarn(...a),
    info: vi.fn(),
  },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublish(...a),
}));

const mockCreatePurchaseIntent = vi.fn();
const mockCreateMandateSetupIntent = vi.fn();
const mockConfirmSavedCardMandate = vi.fn();

/**
 * A stand-in for the real error class. `vi.hoisted` because the `vi.mock` factory below is
 * hoisted above every top-level declaration — and the action's failure mapping is
 * `instanceof`-based, so the SUT and the test must share ONE class identity.
 */
const { TestCreditApiError } = vi.hoisted(() => ({
  TestCreditApiError: class TestCreditApiError extends Error {
    constructor(
      message: string,
      public readonly status?: number,
      public readonly body?: { outcome?: string; error?: string; code?: string | null }
    ) {
      super(message);
      this.name = 'CreditApiError';
    }
  },
}));

vi.mock('./api-client', () => ({
  createPurchaseIntent: (...a: unknown[]) => mockCreatePurchaseIntent(...a),
  createMandateSetupIntent: (...a: unknown[]) => mockCreateMandateSetupIntent(...a),
  confirmSavedCardMandate: (...a: unknown[]) => mockConfirmSavedCardMandate(...a),
  CreditApiError: TestCreditApiError,
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
    mockEnsureForCompany.mockResolvedValue({ id: 'wallet-1', balanceMinor: 0 });
    mockCreatePurchaseIntent.mockResolvedValue({
      outcome: 'needs_client_confirmation',
      clientSecret: 'pi_secret',
      paymentIntentId: 'pi_1',
    });
    mockCreateMandateSetupIntent.mockResolvedValue({ clientSecret: 'seti_secret' });
    mockConfirmSavedCardMandate.mockResolvedValue({ status: 'succeeded', clientSecret: null });
    mockPublish.mockResolvedValue(undefined);
  });

  describe('startPurchaseAction', () => {
    it('gates on MANAGE_BILLING', async () => {
      mockHasCapability.mockResolvedValue(false);
      const res = await startPurchaseAction(baseStartInput());
      expect(res).toEqual({ ok: false, error: 'unauthorized' });
      expect(mockCreatePurchaseIntent).not.toHaveBeenCalled();
      // Provisioning is a WRITE — it must never run ahead of the capability gate.
      expect(mockEnsureForCompany).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range amount as invalid_input', async () => {
      const res = await startPurchaseAction(baseStartInput({ amountMinor: 1 }));
      expect(res).toEqual({ ok: false, error: 'invalid_input' });
    });

    it('PROVISIONS the wallet when the company has never held credit', async () => {
      // The regression this guards: a company with no `credit_wallets` row used to dead-end on
      // `no_wallet`, and since promo redemption was the only other path that creates one, a
      // client who never redeemed a code could never buy credit at all.
      mockEnsureForCompany.mockResolvedValue({ id: 'wallet-new', balanceMinor: 0 });

      const res = await startPurchaseAction(baseStartInput());

      expect(res).toMatchObject({ ok: true, walletId: 'wallet-new' });
      expect(mockEnsureForCompany).toHaveBeenCalledWith(expect.anything(), 'company-1');
      expect(mockCreatePurchaseIntent).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: 'wallet-new' })
      );
    });

    it('reports a provisioning fault as stripe_error, not as a missing balance', async () => {
      // Absence is no longer possible here, so a throw is infrastructure. The buyer must be
      // told no charge was made — never "we couldn't find your balance", which invites them
      // to retry a lookup that was never the problem.
      mockEnsureForCompany.mockRejectedValue(new Error('pool exhausted'));

      const res = await startPurchaseAction(baseStartInput());

      expect(res).toEqual({ ok: false, error: 'stripe_error' });
      expect(mockLogError).toHaveBeenCalledWith(
        'Top-up purchase intent creation failed',
        expect.objectContaining({ error: 'pool exhausted' })
      );
      // A provisioning fault must never reach Stripe — no charge is attempted.
      expect(mockCreatePurchaseIntent).not.toHaveBeenCalled();
    });

    it('persists config, creates BOTH intents for a card-backed mode, and returns both secrets', async () => {
      const res = await startPurchaseAction(baseStartInput());
      expect(res).toEqual({
        ok: true,
        outcome: 'needs_client_confirmation',
        clientSecret: 'pi_secret',
        paymentIntentId: 'pi_1',
        mandate: { outcome: 'requires_action', clientSecret: 'seti_secret' },
        walletId: 'wallet-1',
      });
      expect(mockUpdateConfig).toHaveBeenCalledWith('wallet-1', { lowBalanceMode: 'keep_going' });
      expect(mockCreateMandateSetupIntent).toHaveBeenCalledWith('wallet-1');
    });

    it('skips the SetupIntent when the wallet already has an ACTIVE mandate on the card being charged', async () => {
      mockEnsureForCompany.mockResolvedValue({
        id: 'wallet-1',
        balanceMinor: 0,
        mandateStatus: 'active',
      });
      const res = await startPurchaseAction(baseStartInput({ paymentMethodSource: 'saved_card' }));
      // Opening a SetupIntent would flip a working mandate to 'pending'; and the live mandate
      // was captured against the very card being charged, so it IS captured.
      expect(res).toMatchObject({ ok: true, mandate: { outcome: 'captured' } });
      expect(mockCreateMandateSetupIntent).not.toHaveBeenCalled();
    });

    it('reports NOTHING captured when an active mandate belongs to a card being replaced', async () => {
      // The webhook revokes the old card's mandate the moment a different card is persisted
      // (`applySavedCardDisplay`). Claiming 'captured' here would tell the buyer automatic
      // charging is on for a consent that is about to be cleared.
      mockEnsureForCompany.mockResolvedValue({
        id: 'wallet-1',
        balanceMinor: 0,
        mandateStatus: 'active',
      });
      const res = await startPurchaseAction(baseStartInput({ paymentMethodSource: 'new_card' }));
      expect(res).toMatchObject({ ok: true, mandate: { outcome: 'not_required' } });
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
      expect(res).toMatchObject({ ok: true, mandate: { outcome: 'not_required' } });
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

    it('defaults paymentMethodSource to new_card when the caller omits it', async () => {
      await startPurchaseAction(baseStartInput());
      expect(mockCreatePurchaseIntent).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethodSource: 'new_card' })
      );
    });

    // ── Saved-card branch (top-up redesign) ─────────────────────────────────

    it('forwards saved_card and returns the server-confirmed complete outcome', async () => {
      mockCreatePurchaseIntent.mockResolvedValue({
        outcome: 'complete',
        paymentIntentId: 'pi_saved',
      });
      const res = await startPurchaseAction(
        baseStartInput({
          paymentMethodSource: 'saved_card',
          config: {
            lowBalanceMode: 'notify_only',
            topupReloadMinor: 30_000,
            topupThresholdMinor: 5_000,
          },
        })
      );

      expect(res).toEqual({
        ok: true,
        outcome: 'complete',
        paymentIntentId: 'pi_saved',
        mandate: { outcome: 'not_required' },
        walletId: 'wallet-1',
      });
      expect(mockCreatePurchaseIntent).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethodSource: 'saved_card' })
      );
    });

    it('passes a requires_action outcome through with its client secret', async () => {
      mockCreatePurchaseIntent.mockResolvedValue({
        outcome: 'requires_action',
        clientSecret: 'pi_3ds',
        paymentIntentId: 'pi_saved',
      });
      const res = await startPurchaseAction(
        baseStartInput({
          paymentMethodSource: 'saved_card',
          config: {
            lowBalanceMode: 'notify_only',
            topupReloadMinor: 30_000,
            topupThresholdMinor: 5_000,
          },
        })
      );
      expect(res).toMatchObject({ ok: true, outcome: 'requires_action', clientSecret: 'pi_3ds' });
    });

    it('confirms the mandate against the STORED card, not a fresh SetupIntent', async () => {
      mockCreatePurchaseIntent.mockResolvedValue({
        outcome: 'complete',
        paymentIntentId: 'pi_saved',
      });
      const res = await startPurchaseAction(baseStartInput({ paymentMethodSource: 'saved_card' }));

      expect(mockConfirmSavedCardMandate).toHaveBeenCalledWith('wallet-1');
      expect(mockCreateMandateSetupIntent).not.toHaveBeenCalled();
      // `succeeded` ⇒ nothing for the browser to do; the webhook activates the mandate.
      expect(res).toMatchObject({ ok: true, mandate: { outcome: 'captured' } });
    });

    it('returns the mandate 3DS secret only when the stored-card confirm needs action', async () => {
      mockCreatePurchaseIntent.mockResolvedValue({
        outcome: 'complete',
        paymentIntentId: 'pi_saved',
      });
      mockConfirmSavedCardMandate.mockResolvedValue({
        status: 'requires_action',
        clientSecret: 'seti_3ds',
      });
      const res = await startPurchaseAction(baseStartInput({ paymentMethodSource: 'saved_card' }));
      expect(res).toMatchObject({
        ok: true,
        mandate: { outcome: 'requires_action', clientSecret: 'seti_3ds' },
      });
    });

    it('reports a FAILED stored-card mandate as failed — never as captured (purchase still ok)', async () => {
      // ⚠ The bug this pins: `failed` used to collapse to the same `null` secret as `succeeded`,
      // and the composer read any null on the saved-card path as "captured". The buyer was told
      // automatic charging was on while the wallet sat at `pending` forever.
      mockCreatePurchaseIntent.mockResolvedValue({
        outcome: 'complete',
        paymentIntentId: 'pi_saved',
      });
      mockConfirmSavedCardMandate.mockResolvedValue({ status: 'failed', clientSecret: null });
      const res = await startPurchaseAction(baseStartInput({ paymentMethodSource: 'saved_card' }));
      // The money is already charged — a mandate hiccup never fails the purchase.
      expect(res).toMatchObject({ ok: true, mandate: { outcome: 'failed' } });
    });

    it('treats a requires_action WITHOUT a client secret as failed (the browser cannot act)', async () => {
      mockCreatePurchaseIntent.mockResolvedValue({
        outcome: 'complete',
        paymentIntentId: 'pi_saved',
      });
      mockConfirmSavedCardMandate.mockResolvedValue({
        status: 'requires_action',
        clientSecret: null,
      });
      const res = await startPurchaseAction(baseStartInput({ paymentMethodSource: 'saved_card' }));
      expect(res).toMatchObject({ ok: true, mandate: { outcome: 'failed' } });
    });

    it('never fails a completed purchase because the mandate hop threw (UX 3)', async () => {
      // On the saved-card path the money moved INSIDE createPurchaseIntent. A throw from the
      // second internal hop must not discard a successful purchase as `saved_card_error`.
      mockCreatePurchaseIntent.mockResolvedValue({
        outcome: 'complete',
        paymentIntentId: 'pi_saved',
      });
      mockConfirmSavedCardMandate.mockRejectedValue(new Error('api 502'));
      const res = await startPurchaseAction(baseStartInput({ paymentMethodSource: 'saved_card' }));

      expect(res).toMatchObject({
        ok: true,
        outcome: 'complete',
        paymentIntentId: 'pi_saved',
        mandate: { outcome: 'failed' },
      });
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Mandate capture failed — the top-up itself is unaffected',
        expect.objectContaining({ error: 'api 502' })
      );
    });

    // ── Failure mapping ─────────────────────────────────────────────────────

    it('maps a 402 decline to card_declined with its code, and WARNS rather than errors', async () => {
      mockCreatePurchaseIntent.mockRejectedValue(
        new TestCreditApiError('declined', 402, {
          outcome: 'declined',
          code: 'insufficient_funds',
        })
      );
      const res = await startPurchaseAction(baseStartInput({ paymentMethodSource: 'saved_card' }));

      expect(res).toEqual({
        ok: false,
        error: 'card_declined',
        declineCode: 'insufficient_funds',
      });
      // A decline is a USER outcome, not a system fault.
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Top-up card declined',
        expect.objectContaining({ declineCode: 'insufficient_funds' })
      );
      expect(mockLogError).not.toHaveBeenCalled();
    });

    it('maps a 400 no_saved_card body to no_saved_card', async () => {
      mockCreatePurchaseIntent.mockRejectedValue(
        new TestCreditApiError('no card', 400, { error: 'no_saved_card' })
      );
      const res = await startPurchaseAction(baseStartInput({ paymentMethodSource: 'saved_card' }));
      expect(res).toEqual({ ok: false, error: 'no_saved_card' });
    });

    it('uses saved_card_error — NOT stripe_error — for a saved-card generic failure (R14)', async () => {
      mockCreatePurchaseIntent.mockRejectedValue(new Error('socket hang up'));
      const res = await startPurchaseAction(baseStartInput({ paymentMethodSource: 'saved_card' }));

      // On this path the charge is attempted INSIDE the api call, so the new-card copy
      // ("no charge was made") would be a lie about the buyer's money.
      expect(res).toEqual({ ok: false, error: 'saved_card_error' });
    });

    it('still uses stripe_error for a NEW-card generic failure (nothing was charged)', async () => {
      mockCreatePurchaseIntent.mockRejectedValue(new Error('socket hang up'));
      const res = await startPurchaseAction(baseStartInput({ paymentMethodSource: 'new_card' }));
      expect(res).toEqual({ ok: false, error: 'stripe_error' });
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

    it('rejects an over-long code as invalid without hitting the repo', async () => {
      const result = await validatePromoAction('X'.repeat(65));
      expect(result).toEqual({ ok: false, reason: 'invalid' });
      expect(mockValidate).not.toHaveBeenCalled();
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
      expect(mockEnsureForCompany).not.toHaveBeenCalled();
    });

    it('provisions the wallet when the company has never held credit', async () => {
      mockEnsureForCompany.mockResolvedValue({ id: 'wallet-new', balanceMinor: 0 });

      const res = await saveLowBalanceConfigAction({
        lowBalanceMode: 'notify_only',
        topupReloadMinor: 30_000,
        topupThresholdMinor: 5_000,
      });

      expect(res).toEqual({ ok: true });
      expect(mockEnsureForCompany).toHaveBeenCalledWith(expect.anything(), 'company-1');
      expect(mockUpdateConfig).toHaveBeenCalledWith('wallet-new', {
        lowBalanceMode: 'notify_only',
      });
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
