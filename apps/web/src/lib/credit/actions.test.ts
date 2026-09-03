import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('server-only', () => ({}));

const mockEnsureForCompany = vi.fn();
const mockFindByCompanyId = vi.fn();
const mockUpdateConfig = vi.fn();
const mockValidate = vi.fn();
const mockFindByIdempotencyKey = vi.fn();
const mockHasActiveSessionForWallet = vi.fn();
vi.mock('@balo/db', () => ({
  db: {},
  creditWalletsRepository: {
    ensureForCompany: (...a: unknown[]) => mockEnsureForCompany(...a),
    findByCompanyId: (...a: unknown[]) => mockFindByCompanyId(...a),
    updateConfig: (...a: unknown[]) => mockUpdateConfig(...a),
  },
  creditSessionsRepository: {
    hasActiveSessionForWallet: (...a: unknown[]) => mockHasActiveSessionForWallet(...a),
  },
  creditLedgerRepository: {
    findByIdempotencyKey: (...a: unknown[]) => mockFindByIdempotencyKey(...a),
  },
  promoRedemptionsRepository: {
    validate: (...a: unknown[]) => mockValidate(...a),
  },
  // The REAL derivation shape — a stub that returned a constant would let a key regression
  // (`manual_purchase:{piId}`) pass unnoticed, and that key is the whole terminal condition.
  deriveIdempotencyKey: (input: {
    reason: string;
    paymentIntentId?: string;
    walletId?: string;
    promoCodeId?: string;
  }) =>
    input.reason === 'promo'
      ? `promo:${input.walletId ?? ''}:${input.promoCodeId ?? ''}`
      : `${input.reason}:${input.paymentIntentId ?? ''}`,
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
const mockDetachSavedCardPaymentMethod = vi.fn();

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
  detachSavedCardPaymentMethod: (...a: unknown[]) => mockDetachSavedCardPaymentMethod(...a),
  CreditApiError: TestCreditApiError,
}));

import {
  startPurchaseAction,
  validatePromoAction,
  saveLowBalanceConfigAction,
  nudgeBillingAdminAction,
  getTopUpCreditStatusAction,
  armSavedCardMandateAction,
  startCardCaptureAction,
  removeSavedCardAction,
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
    mockEnsureForCompany.mockResolvedValue({
      id: 'wallet-1',
      balanceMinor: 0,
      stripePaymentMethodId: null,
    });
    mockFindByCompanyId.mockResolvedValue({
      id: 'wallet-1',
      balanceMinor: 0,
      stripePaymentMethodId: null,
    });
    mockFindByIdempotencyKey.mockResolvedValue(undefined);
    mockHasActiveSessionForWallet.mockResolvedValue(false);
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
      // The live mandate was captured against the very card being charged, so it IS captured
      // and a SetupIntent would be pure churn. (saved_card ONLY — see the next case.)
      expect(res).toMatchObject({ ok: true, mandate: { outcome: 'captured' } });
      expect(mockCreateMandateSetupIntent).not.toHaveBeenCalled();
    });

    it('OPENS a SetupIntent for a NEW card even when the old card holds an active mandate', async () => {
      // The regression this guards: `new_card` + active mandate used to return `not_required`,
      // opening no SetupIntent for the new card — while the purchase webhook revokes the OLD
      // card's mandate (a card change). Net effect: an auto-top-up client who paid with a new
      // card silently lost auto-top-up (`mandate_status = NULL`), and the only signal was the
      // receipt's small warning. Safe to open now: `applyMandateStatus` refuses
      // active → pending, so the SetupIntent's pending write cannot downgrade the live mandate,
      // and either webhook order converges on `active` for the new card.
      mockEnsureForCompany.mockResolvedValue({
        id: 'wallet-1',
        balanceMinor: 0,
        mandateStatus: 'active',
      });

      const res = await startPurchaseAction(baseStartInput({ paymentMethodSource: 'new_card' }));

      expect(mockCreateMandateSetupIntent).toHaveBeenCalledWith('wallet-1');
      expect(res).toMatchObject({
        ok: true,
        mandate: { outcome: 'requires_action', clientSecret: 'seti_secret' },
      });
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

      expect(mockConfirmSavedCardMandate).toHaveBeenCalledWith('wallet-1', CLIENT_REQUEST_ID);
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
      // promoCodeId rides along so the receipt can later ask whether the grant landed.
      expect(await validatePromoAction('WELCOME50')).toEqual({
        ok: true,
        grantMinor: 5_000,
        promoCodeId: 'p1',
      });
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

  describe('armSavedCardMandateAction', () => {
    const CLIENT_REQUEST_ID_2 = '22222222-2222-4222-8222-222222222222';

    it('gates on MANAGE_BILLING', async () => {
      mockHasCapability.mockResolvedValue(false);
      const res = await armSavedCardMandateAction({ clientRequestId: CLIENT_REQUEST_ID_2 });
      expect(res).toEqual({ ok: false, error: 'unauthorized' });
      expect(mockConfirmSavedCardMandate).not.toHaveBeenCalled();
    });

    it('rejects an invalid clientRequestId', async () => {
      const res = await armSavedCardMandateAction({ clientRequestId: 'not-a-uuid' });
      expect(res).toEqual({ ok: false, error: 'invalid_input' });
      expect(mockConfirmSavedCardMandate).not.toHaveBeenCalled();
    });

    it('returns no_saved_card when there is no wallet', async () => {
      mockFindByCompanyId.mockResolvedValue(undefined);
      const res = await armSavedCardMandateAction({ clientRequestId: CLIENT_REQUEST_ID_2 });
      expect(res).toEqual({ ok: false, error: 'no_saved_card' });
      expect(mockConfirmSavedCardMandate).not.toHaveBeenCalled();
    });

    it('returns no_saved_card when the wallet has no stored payment method', async () => {
      mockFindByCompanyId.mockResolvedValue({
        id: 'wallet-1',
        stripeCustomerId: null,
        stripePaymentMethodId: null,
        mandateStatus: null,
      });
      const res = await armSavedCardMandateAction({ clientRequestId: CLIENT_REQUEST_ID_2 });
      expect(res).toEqual({ ok: false, error: 'no_saved_card' });
    });

    it('short-circuits captured when the mandate is already active, WITHOUT calling the api', async () => {
      mockFindByCompanyId.mockResolvedValue({
        id: 'wallet-1',
        stripeCustomerId: 'cus_1',
        stripePaymentMethodId: 'pm_1',
        mandateStatus: 'active',
      });
      const res = await armSavedCardMandateAction({ clientRequestId: CLIENT_REQUEST_ID_2 });
      expect(res).toEqual({ ok: true, outcome: 'captured' });
      expect(mockConfirmSavedCardMandate).not.toHaveBeenCalled();
    });

    it('maps succeeded to captured', async () => {
      mockFindByCompanyId.mockResolvedValue({
        id: 'wallet-1',
        stripeCustomerId: 'cus_1',
        stripePaymentMethodId: 'pm_1',
        mandateStatus: 'pending',
      });
      mockConfirmSavedCardMandate.mockResolvedValue({ status: 'succeeded', clientSecret: null });
      const res = await armSavedCardMandateAction({ clientRequestId: CLIENT_REQUEST_ID_2 });
      expect(res).toEqual({ ok: true, outcome: 'captured' });
      expect(mockConfirmSavedCardMandate).toHaveBeenCalledWith('wallet-1', CLIENT_REQUEST_ID_2);
    });

    it('maps requires_action WITH a secret to requires_action', async () => {
      mockFindByCompanyId.mockResolvedValue({
        id: 'wallet-1',
        stripeCustomerId: 'cus_1',
        stripePaymentMethodId: 'pm_1',
        mandateStatus: 'pending',
      });
      mockConfirmSavedCardMandate.mockResolvedValue({
        status: 'requires_action',
        clientSecret: 'seti_secret',
      });
      const res = await armSavedCardMandateAction({ clientRequestId: CLIENT_REQUEST_ID_2 });
      expect(res).toEqual({ ok: true, outcome: 'requires_action', clientSecret: 'seti_secret' });
    });

    it('maps requires_action with a NULL secret to failed (the browser cannot act on it)', async () => {
      mockFindByCompanyId.mockResolvedValue({
        id: 'wallet-1',
        stripeCustomerId: 'cus_1',
        stripePaymentMethodId: 'pm_1',
        mandateStatus: 'pending',
      });
      mockConfirmSavedCardMandate.mockResolvedValue({
        status: 'requires_action',
        clientSecret: null,
      });
      const res = await armSavedCardMandateAction({ clientRequestId: CLIENT_REQUEST_ID_2 });
      expect(res).toEqual({ ok: false, error: 'failed' });
    });

    it('maps a terminal failed status to failed', async () => {
      mockFindByCompanyId.mockResolvedValue({
        id: 'wallet-1',
        stripeCustomerId: 'cus_1',
        stripePaymentMethodId: 'pm_1',
        mandateStatus: 'pending',
      });
      mockConfirmSavedCardMandate.mockResolvedValue({ status: 'failed', clientSecret: null });
      const res = await armSavedCardMandateAction({ clientRequestId: CLIENT_REQUEST_ID_2 });
      expect(res).toEqual({ ok: false, error: 'failed' });
    });

    it('maps a thrown error to failed (never lets a network hiccup crash Save), logging companyId (security LOW)', async () => {
      mockFindByCompanyId.mockResolvedValue({
        id: 'wallet-1',
        stripeCustomerId: 'cus_1',
        stripePaymentMethodId: 'pm_1',
        mandateStatus: 'pending',
      });
      mockConfirmSavedCardMandate.mockRejectedValue(new Error('network blip'));
      const res = await armSavedCardMandateAction({ clientRequestId: CLIENT_REQUEST_ID_2 });
      expect(res).toEqual({ ok: false, error: 'failed' });
      const [, context] = mockLogError.mock.calls[0] as [string, Record<string, unknown>];
      expect(context).toMatchObject({ companyId: 'company-1' });
    });
  });

  describe('startCardCaptureAction', () => {
    const PREV_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

    beforeEach(() => {
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_settings';
    });
    afterAll(() => {
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = PREV_PUBLISHABLE_KEY;
    });

    it('gates on MANAGE_BILLING', async () => {
      mockHasCapability.mockResolvedValue(false);
      const res = await startCardCaptureAction();
      expect(res).toEqual({ ok: false, error: 'unauthorized' });
      expect(mockEnsureForCompany).not.toHaveBeenCalled();
    });

    it('returns unconfigured when the publishable key is missing', async () => {
      delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      const res = await startCardCaptureAction();
      expect(res).toEqual({ ok: false, error: 'unconfigured' });
      expect(mockEnsureForCompany).not.toHaveBeenCalled();
    });

    it('provisions the wallet (a company may add a card first) and returns the secret + key — a first Add never consults the settlement guard', async () => {
      mockEnsureForCompany.mockResolvedValue({ id: 'wallet-1', stripePaymentMethodId: null });
      mockCreateMandateSetupIntent.mockResolvedValue({ clientSecret: 'seti_secret' });

      const res = await startCardCaptureAction();

      expect(res).toEqual({
        ok: true,
        clientSecret: 'seti_secret',
        publishableKey: 'pk_test_settings',
      });
      expect(mockEnsureForCompany).toHaveBeenCalledWith(expect.anything(), 'company-1');
      expect(mockCreateMandateSetupIntent).toHaveBeenCalledWith('wallet-1');
      // FIX ROUND 2 (security MEDIUM — NEW-1) asymmetry: a first Add is not an evasion surface,
      // so it must not even query the session guard.
      expect(mockHasActiveSessionForWallet).not.toHaveBeenCalled();
    });

    it('refuses a card CHANGE while the wallet has a live overdraft-grace session (fix round 2 G2 — closes the variant survivor of the removal exploit)', async () => {
      mockEnsureForCompany.mockResolvedValue({ id: 'wallet-1', stripePaymentMethodId: 'pm_old' });
      mockHasActiveSessionForWallet.mockResolvedValue(true);

      const res = await startCardCaptureAction();

      expect(res).toEqual({ ok: false, error: 'settlement_outstanding' });
      expect(mockHasActiveSessionForWallet).toHaveBeenCalledWith('wallet-1');
      expect(mockCreateMandateSetupIntent).not.toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Card change refused — settlement outstanding on the wallet',
        expect.objectContaining({ walletId: 'wallet-1', companyId: 'company-1' })
      );
    });

    it('allows a card CHANGE with no active session — the guard is session-scoped, not receivable-scoped', async () => {
      mockEnsureForCompany.mockResolvedValue({ id: 'wallet-1', stripePaymentMethodId: 'pm_old' });
      mockHasActiveSessionForWallet.mockResolvedValue(false);
      mockCreateMandateSetupIntent.mockResolvedValue({ clientSecret: 'seti_secret' });

      const res = await startCardCaptureAction();

      expect(res).toEqual({
        ok: true,
        clientSecret: 'seti_secret',
        publishableKey: 'pk_test_settings',
      });
      expect(mockHasActiveSessionForWallet).toHaveBeenCalledWith('wallet-1');
      expect(mockCreateMandateSetupIntent).toHaveBeenCalledWith('wallet-1');
    });

    it('maps a thrown error to error, logging companyId (security LOW)', async () => {
      mockEnsureForCompany.mockRejectedValue(new Error('db down'));
      const res = await startCardCaptureAction();
      expect(res).toEqual({ ok: false, error: 'error' });
      const [, context] = mockLogError.mock.calls[0] as [string, Record<string, unknown>];
      expect(context).toMatchObject({ companyId: 'company-1' });
    });
  });

  describe('removeSavedCardAction', () => {
    it('gates on MANAGE_BILLING', async () => {
      mockHasCapability.mockResolvedValue(false);
      const res = await removeSavedCardAction();
      expect(res).toEqual({ ok: false, error: 'unauthorized' });
      expect(mockDetachSavedCardPaymentMethod).not.toHaveBeenCalled();
    });

    it('returns no_wallet when the company has no wallet row, and NEVER provisions one', async () => {
      mockFindByCompanyId.mockResolvedValue(undefined);
      const res = await removeSavedCardAction();
      expect(res).toEqual({ ok: false, error: 'no_wallet' });
      expect(mockDetachSavedCardPaymentMethod).not.toHaveBeenCalled();
      expect(mockEnsureForCompany).not.toHaveBeenCalled();
    });

    it('passes through the effective mode, using the wallet resolved from the SESSION company', async () => {
      mockFindByCompanyId.mockResolvedValue({ id: 'wallet-1' });
      mockDetachSavedCardPaymentMethod.mockResolvedValue({
        removed: true,
        lowBalanceMode: 'notify_only',
        modeReconciled: true,
      });

      const res = await removeSavedCardAction();

      expect(res).toEqual({ ok: true, lowBalanceMode: 'notify_only', modeReconciled: true });
      // The wallet id crossing the internal hop is the one resolved from
      // `findByCompanyId(actor.companyId)` — never anything the client could supply.
      expect(mockDetachSavedCardPaymentMethod).toHaveBeenCalledWith('wallet-1');
    });

    it('maps a CreditApiError to error, logging walletId + companyId for forensics (security LOW)', async () => {
      mockFindByCompanyId.mockResolvedValue({ id: 'wallet-1' });
      mockDetachSavedCardPaymentMethod.mockRejectedValue(
        new TestCreditApiError('failed', 502, { error: 'stripe_detach_failed' })
      );

      const res = await removeSavedCardAction();

      expect(res).toEqual({ ok: false, error: 'error' });
      const [, context] = mockLogError.mock.calls[0] as [string, Record<string, unknown>];
      expect(context).toMatchObject({ walletId: 'wallet-1', companyId: 'company-1' });
    });

    it('maps the 409 settlement_outstanding refusal to its own error arm — never the generic error (security MEDIUM)', async () => {
      mockFindByCompanyId.mockResolvedValue({ id: 'wallet-1' });
      mockDetachSavedCardPaymentMethod.mockRejectedValue(
        new TestCreditApiError('conflict', 409, { error: 'settlement_outstanding' })
      );

      const res = await removeSavedCardAction();

      expect(res).toEqual({ ok: false, error: 'settlement_outstanding' });
      // A refusal is expected/user-actionable, not a fault — warn, not error.
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Saved card removal refused — settlement outstanding on the wallet',
        { walletId: 'wallet-1', companyId: 'company-1' }
      );
      expect(mockLogError).not.toHaveBeenCalled();
    });
  });

  describe('getTopUpCreditStatusAction', () => {
    it('gates on MANAGE_BILLING and reads nothing', async () => {
      mockHasCapability.mockResolvedValue(false);
      expect(await getTopUpCreditStatusAction('pi_1')).toEqual({ status: 'unauthorized' });
      expect(mockFindByCompanyId).not.toHaveBeenCalled();
      expect(mockFindByIdempotencyKey).not.toHaveBeenCalled();
    });

    it('asks the ledger for the PI-derived manual_purchase key', async () => {
      await getTopUpCreditStatusAction('pi_abc');
      expect(mockFindByIdempotencyKey).toHaveBeenCalledWith('manual_purchase:pi_abc');
    });

    it('returns credited with the ACTOR-OWN wallet balance once the entry lands', async () => {
      // ⚠ Deliberately NOT `previous + amount + promo` — the standing guard that the answer is a
      // READ of the wallet, never arithmetic.
      mockFindByCompanyId.mockResolvedValue({ id: 'wallet-1', balanceMinor: 137_500 });
      mockFindByIdempotencyKey.mockResolvedValue({ id: 'le_1', walletId: 'wallet-1' });

      expect(await getTopUpCreditStatusAction('pi_1')).toEqual({
        status: 'credited',
        balanceMinor: 137_500,
        promoGranted: null, // no promo asked about
      });
    });

    it('answers promoGranted TRUE only when the grant key is in the ledger', async () => {
      // The settlement webhook re-validates the promo and can SKIP the grant while the base
      // credit lands — so the receipt must ASK, not render the bonus off apply-time state.
      mockFindByCompanyId.mockResolvedValue({ id: 'wallet-1', balanceMinor: 105_000 });
      const PROMO_ID = '550e8400-e29b-41d4-a716-446655440077';
      mockFindByIdempotencyKey.mockImplementation((key: string) =>
        key === 'manual_purchase:pi_1' || key === `promo:wallet-1:${PROMO_ID}`
          ? { id: 'le', walletId: 'wallet-1' }
          : undefined
      );

      const res = await getTopUpCreditStatusAction('pi_1', PROMO_ID);

      expect(res).toEqual({ status: 'credited', balanceMinor: 105_000, promoGranted: true });
      // The grant key is checked against the ACTOR's wallet — the wallet id is half the key.
      expect(mockFindByIdempotencyKey).toHaveBeenCalledWith(`promo:wallet-1:${PROMO_ID}`);
    });

    it('answers promoGranted FALSE when the purchase credited but the grant was skipped', async () => {
      mockFindByCompanyId.mockResolvedValue({ id: 'wallet-1', balanceMinor: 100_000 });
      mockFindByIdempotencyKey.mockImplementation((key: string) =>
        key === 'manual_purchase:pi_1' ? { id: 'le', walletId: 'wallet-1' } : undefined
      );

      const res = await getTopUpCreditStatusAction('pi_1', '550e8400-e29b-41d4-a716-446655440077');

      expect(res).toEqual({ status: 'credited', balanceMinor: 100_000, promoGranted: false });
    });

    it('answers promoGranted FALSE (never an error) for a malformed promoCodeId', async () => {
      mockFindByCompanyId.mockResolvedValue({ id: 'wallet-1', balanceMinor: 100_000 });
      mockFindByIdempotencyKey.mockImplementation((key: string) =>
        key === 'manual_purchase:pi_1' ? { id: 'le', walletId: 'wallet-1' } : undefined
      );

      const res = await getTopUpCreditStatusAction('pi_1', 'not-a-uuid');

      expect(res).toMatchObject({ status: 'credited', promoGranted: false });
    });

    it('returns pending while the webhook has not posted the entry', async () => {
      mockFindByCompanyId.mockResolvedValue({ id: 'wallet-1', balanceMinor: 2_500 });
      mockFindByIdempotencyKey.mockResolvedValue(undefined);

      expect(await getTopUpCreditStatusAction('pi_1')).toEqual({
        status: 'pending',
        balanceMinor: 2_500,
      });
    });

    it('⚠ IDOR — an entry on ANOTHER wallet reads exactly like no entry, and leaks no balance', async () => {
      // The key is `manual_purchase:{piId}` — derived wholly from caller input, so it is
      // guessable. A foreign hit must be reported to nobody.
      mockFindByCompanyId.mockResolvedValue({ id: 'wallet-mine', balanceMinor: 2_500 });
      mockFindByIdempotencyKey.mockResolvedValue({
        id: 'le_other',
        walletId: 'wallet-someone-else',
        // Present precisely so the assertion below can prove it never escapes.
        amountMinor: 999_999,
      });

      const res = await getTopUpCreditStatusAction('pi_guessed');

      expect(res).toEqual({ status: 'pending', balanceMinor: 2_500 });
      expect(JSON.stringify(res)).not.toContain('999999');
      expect(JSON.stringify(res)).not.toContain('wallet-someone-else');
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Top-up credit status asked about a PaymentIntent from another wallet',
        expect.objectContaining({ companyId: 'company-1', walletId: 'wallet-mine' })
      );
    });

    it('⚠ a company with NO wallet row reads pending at 0 — and NEVER mints one', async () => {
      // `ensureForCompany` is a WRITE, and this read runs ~13 times per receipt. A status check
      // must not conjure a wallet for a company that never bought anything.
      mockFindByCompanyId.mockResolvedValue(undefined);

      expect(await getTopUpCreditStatusAction('pi_1')).toEqual({
        status: 'pending',
        balanceMinor: 0,
      });
      expect(mockEnsureForCompany).not.toHaveBeenCalled();
      // No wallet ⇒ nothing to scope a ledger answer to, so it never asks.
      expect(mockFindByIdempotencyKey).not.toHaveBeenCalled();
    });

    it('rejects a structurally invalid id without a DB round-trip', async () => {
      expect(await getTopUpCreditStatusAction('x'.repeat(256))).toEqual({ status: 'error' });
      expect(mockFindByCompanyId).not.toHaveBeenCalled();
    });

    it('logs and returns error — carrying NO balance — when the read throws', async () => {
      mockFindByIdempotencyKey.mockRejectedValue(new Error('pool exhausted'));

      const res = await getTopUpCreditStatusAction('pi_1');

      // Reporting a DB blip as `balanceMinor: 0` would be the same class of lie the client
      // arithmetic was.
      expect(res).toEqual({ status: 'error' });
      expect(mockLogError).toHaveBeenCalledWith(
        'Top-up credit status read failed',
        expect.objectContaining({ error: 'pool exhausted' })
      );
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
