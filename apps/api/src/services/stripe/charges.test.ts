import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('stripe', async () => (await import('../../test/mocks/stripe.js')).stripeMockModule());
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  createOffSessionCharge,
  createOnSessionPurchaseIntent,
  retrieveSettlement,
} from './charges.js';
import { StripeSettlementError } from './errors.js';
import { mockStripe, MockStripeCardError, resetStripeMock } from '../../test/mocks/stripe.js';

describe('charges', () => {
  const originalKey = process.env.STRIPE_SECRET_KEY;

  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  });
  afterAll(() => {
    process.env.STRIPE_SECRET_KEY = originalKey;
  });
  beforeEach(() => {
    resetStripeMock();
  });

  describe('createOnSessionPurchaseIntent', () => {
    it('creates a PI with setup_future_usage off_session and member-attributed metadata', async () => {
      mockStripe.paymentIntents.create.mockResolvedValue({
        id: 'pi_1',
        client_secret: 'pi_1_secret',
      });

      const result = await createOnSessionPurchaseIntent({
        walletId: 'wallet_1',
        customerId: 'cus_1',
        presentmentCurrency: 'usd',
        presentmentAmountMinor: 5000,
        initiatingMemberId: 'member_1',
        idempotencyKey: 'purchase:wallet_1:req_1',
      });

      expect(result).toEqual({ clientSecret: 'pi_1_secret', paymentIntentId: 'pi_1' });
      // The caller idempotency key is forwarded as the Stripe 2nd-arg — a retried / double
      // create returns the SAME PI, so the wallet is never double-credited.
      expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 5000,
          currency: 'usd',
          customer: 'cus_1',
          setup_future_usage: 'off_session',
          metadata: { walletId: 'wallet_1', reason: 'manual_purchase', memberId: 'member_1' },
        }),
        { idempotencyKey: 'purchase:wallet_1:req_1' }
      );
      // Never sets payment_method_types (dynamic payment methods).
      expect(mockStripe.paymentIntents.create.mock.calls[0]?.[0]).not.toHaveProperty(
        'payment_method_types'
      );
    });

    it('stamps an optional promoCode into the PI metadata when present', async () => {
      mockStripe.paymentIntents.create.mockResolvedValue({
        id: 'pi_1',
        client_secret: 'pi_1_secret',
      });

      await createOnSessionPurchaseIntent({
        walletId: 'wallet_1',
        customerId: 'cus_1',
        presentmentCurrency: 'usd',
        presentmentAmountMinor: 5000,
        initiatingMemberId: 'member_1',
        idempotencyKey: 'purchase:wallet_1:req_1',
        promoCode: 'WELCOME50',
      });

      expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            walletId: 'wallet_1',
            reason: 'manual_purchase',
            memberId: 'member_1',
            promoCode: 'WELCOME50',
          },
        }),
        { idempotencyKey: 'purchase:wallet_1:req_1' }
      );
    });

    it('omits promoCode from metadata when absent', async () => {
      mockStripe.paymentIntents.create.mockResolvedValue({
        id: 'pi_1',
        client_secret: 'pi_1_secret',
      });

      await createOnSessionPurchaseIntent({
        walletId: 'wallet_1',
        customerId: 'cus_1',
        presentmentCurrency: 'usd',
        presentmentAmountMinor: 5000,
        initiatingMemberId: 'member_1',
        idempotencyKey: 'purchase:wallet_1:req_1',
      });

      expect(mockStripe.paymentIntents.create.mock.calls[0]?.[0]?.metadata).not.toHaveProperty(
        'promoCode'
      );
    });

    it('throws when Stripe returns a PI without a client_secret', async () => {
      mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_1', client_secret: null });
      await expect(
        createOnSessionPurchaseIntent({
          walletId: 'wallet_1',
          customerId: 'cus_1',
          presentmentCurrency: 'usd',
          presentmentAmountMinor: 5000,
          initiatingMemberId: 'member_1',
          idempotencyKey: 'purchase:wallet_1:req_1',
        })
      ).rejects.toThrow(/client_secret/);
    });
  });

  describe('createOffSessionCharge', () => {
    it('returns processing and stamps the idempotency key as both Stripe key and metadata', async () => {
      mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_2' });

      const result = await createOffSessionCharge({
        walletId: 'wallet_1',
        customerId: 'cus_1',
        paymentMethodId: 'pm_1',
        currency: 'aud',
        amountMinor: 10000,
        reason: 'overdraft_settlement',
        idempotencyKey: 'overdraft_settlement:session_1',
        memberId: 'member_1',
        sessionId: 'session_1',
      });

      expect(result).toEqual({ status: 'processing', paymentIntentId: 'pi_2' });
      expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 10000,
          currency: 'aud',
          customer: 'cus_1',
          payment_method: 'pm_1',
          off_session: true,
          confirm: true,
          metadata: expect.objectContaining({
            walletId: 'wallet_1',
            reason: 'overdraft_settlement',
            idempotencyKey: 'overdraft_settlement:session_1',
            memberId: 'member_1',
            sessionId: 'session_1',
          }),
        }),
        { idempotencyKey: 'overdraft_settlement:session_1' }
      );
    });

    it('returns requires_action (WITHOUT throwing) on authentication_required (SCA)', async () => {
      mockStripe.paymentIntents.create.mockRejectedValue(
        new MockStripeCardError({
          code: 'authentication_required',
          payment_intent: { id: 'pi_3', client_secret: 'pi_3_secret' },
        })
      );

      const result = await createOffSessionCharge({
        walletId: 'wallet_1',
        customerId: 'cus_1',
        paymentMethodId: 'pm_1',
        currency: 'aud',
        amountMinor: 10000,
        reason: 'auto_topup',
        idempotencyKey: 'auto_topup:wallet_1:entry_1',
        triggeringEntryId: 'entry_1',
      });

      expect(result).toEqual({
        status: 'requires_action',
        paymentIntentId: 'pi_3',
        clientSecret: 'pi_3_secret',
      });
    });

    it('re-throws a hard decline (non-authentication card error)', async () => {
      mockStripe.paymentIntents.create.mockRejectedValue(
        new MockStripeCardError({ code: 'card_declined' })
      );

      await expect(
        createOffSessionCharge({
          walletId: 'wallet_1',
          customerId: 'cus_1',
          paymentMethodId: 'pm_1',
          currency: 'aud',
          amountMinor: 10000,
          reason: 'auto_topup',
          idempotencyKey: 'auto_topup:wallet_1:entry_1',
          triggeringEntryId: 'entry_1',
        })
      ).rejects.toBeInstanceOf(MockStripeCardError);
    });
  });

  describe('retrieveSettlement (price / fx mapping)', () => {
    it('maps an AUD→AUD charge: gross AUD credit, null fxRate', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_4', latest_charge: 'ch_4' });
      mockStripe.charges.retrieve.mockResolvedValue({
        id: 'ch_4',
        currency: 'aud',
        amount: 10000,
        balance_transaction: { id: 'txn_4', amount: 10000, currency: 'aud', exchange_rate: null },
      });

      const settlement = await retrieveSettlement('pi_4');

      expect(settlement).toEqual({
        creditAmountMinor: 10000,
        chargedCurrency: 'aud',
        chargedAmountMinor: 10000,
        fxRate: null,
        stripePaymentIntentId: 'pi_4',
        stripeChargeId: 'ch_4',
        stripeBalanceTransactionId: 'txn_4',
      });
      expect(mockStripe.charges.retrieve).toHaveBeenCalledWith('ch_4', {
        expand: ['balance_transaction'],
      });
    });

    it('maps a USD→AUD charge: gross settled AUD credit distinct from presentment, fx captured', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_5', latest_charge: 'ch_5' });
      mockStripe.charges.retrieve.mockResolvedValue({
        id: 'ch_5',
        currency: 'usd',
        amount: 5000, // presentment minor units (USD)
        balance_transaction: {
          id: 'txn_5',
          amount: 7600, // GROSS settled AUD minor units → the credit granted
          currency: 'aud',
          exchange_rate: 1.52,
        },
      });

      const settlement = await retrieveSettlement('pi_5');

      expect(settlement.creditAmountMinor).toBe(7600); // gross AUD, NOT the presentment 5000
      expect(settlement.chargedCurrency).toBe('usd');
      expect(settlement.chargedAmountMinor).toBe(5000);
      expect(settlement.fxRate).toBe('1.52');
      expect(settlement.stripeChargeId).toBe('ch_5');
      expect(settlement.stripeBalanceTransactionId).toBe('txn_5');
    });

    it('resolves latest_charge when it is an expanded object', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_6',
        latest_charge: { id: 'ch_6' },
      });
      mockStripe.charges.retrieve.mockResolvedValue({
        id: 'ch_6',
        currency: 'aud',
        amount: 2000,
        balance_transaction: { id: 'txn_6', amount: 2000, currency: 'aud', exchange_rate: null },
      });

      const settlement = await retrieveSettlement('pi_6');
      expect(settlement.stripeChargeId).toBe('ch_6');
    });

    it('throws when the PaymentIntent has no latest_charge', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_7', latest_charge: null });
      await expect(retrieveSettlement('pi_7')).rejects.toThrow(/latest_charge/);
    });

    it('throws when the charge has no expanded balance_transaction', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_8', latest_charge: 'ch_8' });
      mockStripe.charges.retrieve.mockResolvedValue({
        id: 'ch_8',
        currency: 'aud',
        amount: 2000,
        balance_transaction: 'txn_8', // un-expanded (string id)
      });
      await expect(retrieveSettlement('pi_8')).rejects.toThrow(/balance_transaction/);
    });

    it('throws StripeSettlementError when the settlement is not AUD (money-integrity guard)', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_9', latest_charge: 'ch_9' });
      mockStripe.charges.retrieve.mockResolvedValue({
        id: 'ch_9',
        currency: 'usd',
        amount: 5000,
        balance_transaction: { id: 'txn_9', amount: 5000, currency: 'usd', exchange_rate: null },
      });
      await expect(retrieveSettlement('pi_9')).rejects.toBeInstanceOf(StripeSettlementError);
    });
  });
});
