import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('stripe', async () => (await import('../../test/mocks/stripe.js')).stripeMockModule());
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  createOffSessionCharge,
  createOnSessionPurchaseIntent,
  createOnSessionSavedCardCharge,
  findPaymentIntentByIdempotencyKey,
  retrievePaymentIntentStatus,
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

  describe('createOnSessionSavedCardCharge', () => {
    const savedCardInput = {
      walletId: 'wallet_1',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      presentmentCurrency: 'aud',
      presentmentAmountMinor: 100_000,
      initiatingMemberId: 'member_1',
      idempotencyKey: 'purchase:wallet_1:req_1',
      returnUrl: 'https://app.balo.test/billing/top-up',
    };

    it('creates a CONFIRMED PI against the stored card with the buyer present', async () => {
      mockStripe.paymentIntents.create.mockResolvedValue({
        id: 'pi_s1',
        status: 'succeeded',
        client_secret: 'pi_s1_secret',
      });

      const result = await createOnSessionSavedCardCharge(savedCardInput);

      expect(result).toEqual({
        outcome: 'confirmed',
        status: 'succeeded',
        clientSecret: 'pi_s1_secret',
        paymentIntentId: 'pi_s1',
      });
      expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 100_000,
          currency: 'aud',
          customer: 'cus_1',
          payment_method: 'pm_1',
          // `false` is load-bearing: the buyer IS here, so a 3DS challenge must be answerable.
          off_session: false,
          confirm: true,
          setup_future_usage: 'off_session',
          use_stripe_sdk: true,
          return_url: 'https://app.balo.test/billing/top-up',
        }),
        { idempotencyKey: 'purchase:wallet_1:req_1' }
      );
    });

    it('stamps metadata IDENTICAL to the new-card path (the webhook cannot tell them apart)', async () => {
      mockStripe.paymentIntents.create.mockResolvedValue({
        id: 'pi_a',
        status: 'succeeded',
        client_secret: 'sec_a',
      });
      await createOnSessionSavedCardCharge({ ...savedCardInput, promoCode: 'WELCOME50' });
      const [savedParams] = mockStripe.paymentIntents.create.mock.calls[0] as [
        Record<string, unknown>,
      ];

      mockStripe.paymentIntents.create.mockClear();
      mockStripe.paymentIntents.create.mockResolvedValue({ id: 'pi_b', client_secret: 'sec_b' });
      await createOnSessionPurchaseIntent({
        walletId: 'wallet_1',
        customerId: 'cus_1',
        presentmentCurrency: 'aud',
        presentmentAmountMinor: 100_000,
        initiatingMemberId: 'member_1',
        idempotencyKey: 'purchase:wallet_1:req_1',
        promoCode: 'WELCOME50',
      });
      const [newParams] = mockStripe.paymentIntents.create.mock.calls[0] as [
        Record<string, unknown>,
      ];

      // Deep-equal, not a subset: an extra or missing metadata key on either path would change
      // how `resolvePaymentIntentSucceeded` credits, receipts and reconciles the purchase.
      expect(savedParams.metadata).toEqual(newParams.metadata);
      expect(savedParams.metadata).toEqual({
        walletId: 'wallet_1',
        reason: 'manual_purchase',
        memberId: 'member_1',
        promoCode: 'WELCOME50',
      });
    });

    it('surfaces requires_action with the client secret for 3DS', async () => {
      mockStripe.paymentIntents.create.mockResolvedValue({
        id: 'pi_s2',
        status: 'requires_action',
        client_secret: 'pi_s2_secret',
      });

      await expect(createOnSessionSavedCardCharge(savedCardInput)).resolves.toEqual({
        outcome: 'confirmed',
        status: 'requires_action',
        clientSecret: 'pi_s2_secret',
        paymentIntentId: 'pi_s2',
      });
    });

    it('returns a typed decline (never throws) when the card is refused', async () => {
      mockStripe.paymentIntents.create.mockRejectedValue(
        new MockStripeCardError({
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          payment_intent: { id: 'pi_s3' },
        })
      );

      await expect(createOnSessionSavedCardCharge(savedCardInput)).resolves.toEqual({
        outcome: 'declined',
        code: 'insufficient_funds',
        paymentIntentId: 'pi_s3',
      });
    });

    it('treats a PI parked back in requires_payment_method as a decline', async () => {
      mockStripe.paymentIntents.create.mockResolvedValue({
        id: 'pi_s4',
        status: 'requires_payment_method',
        client_secret: 'pi_s4_secret',
        last_payment_error: { code: 'card_declined', decline_code: 'do_not_honor' },
      });

      await expect(createOnSessionSavedCardCharge(savedCardInput)).resolves.toEqual({
        outcome: 'declined',
        code: 'do_not_honor',
        paymentIntentId: 'pi_s4',
      });
    });

    it('re-throws a non-card Stripe failure', async () => {
      mockStripe.paymentIntents.create.mockRejectedValue(new Error('network down'));
      await expect(createOnSessionSavedCardCharge(savedCardInput)).rejects.toThrow(/network down/);
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

    it('does NOT poll when the expansion was dropped (string arm is permanent, not a race)', async () => {
      // A bare id back means our `expand` was not applied — re-reading returns the identical
      // response, so retrying would only burn the delay budget. The call-count assertion is
      // the load-bearing half: it stops a refactor from folding this into the retry arm.
      mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_8', latest_charge: 'ch_8' });
      mockStripe.charges.retrieve.mockResolvedValue({
        id: 'ch_8',
        currency: 'aud',
        amount: 2000,
        balance_transaction: 'txn_8', // un-expanded (string id)
      });

      await expect(retrieveSettlement('pi_8')).rejects.toThrow(/expand was not applied/);
      expect(mockStripe.charges.retrieve).toHaveBeenCalledTimes(1);
    });

    it('POLLS and settles when the balance transaction lands late (the observed race)', async () => {
      // The bug this guards: `payment_intent.succeeded` arrived ~1s after a real A$1,000
      // charge, before Stripe had created the balance transaction. The webhook 500'd and the
      // wallet was never credited, while the buyer saw a success receipt.
      mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_r', latest_charge: 'ch_r' });
      mockStripe.charges.retrieve
        .mockResolvedValueOnce({
          id: 'ch_r',
          currency: 'aud',
          amount: 100_000,
          balance_transaction: null, // not created yet
        })
        .mockResolvedValueOnce({
          id: 'ch_r',
          currency: 'aud',
          amount: 100_000,
          balance_transaction: {
            id: 'txn_r',
            amount: 100_000,
            currency: 'aud',
            exchange_rate: null,
          },
        });

      const settlement = await retrieveSettlement('pi_r', [0]);

      // These two assertions are a PAIR on purpose: a `charge.amount` fallback would satisfy
      // the amount while leaving the balance-transaction id null, so together they pin that
      // the settled figure came from the balance transaction and stays traceable.
      expect(settlement.creditAmountMinor).toBe(100_000);
      expect(settlement.stripeBalanceTransactionId).toBe('txn_r');
      expect(mockStripe.charges.retrieve).toHaveBeenCalledTimes(2);
    });

    it('still throws once the wait is exhausted, preserving the Stripe-retry backstop', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_x', latest_charge: 'ch_x' });
      mockStripe.charges.retrieve.mockResolvedValue({
        id: 'ch_x',
        currency: 'aud',
        amount: 2000,
        balance_transaction: null,
      });

      await expect(retrieveSettlement('pi_x', [0, 0])).rejects.toThrow(
        /no balance_transaction yet/
      );
      // 1 initial read + 2 retries. The throw is deliberate: it becomes a 500, and Stripe's
      // redelivery is what actually credits the wallet.
      expect(mockStripe.charges.retrieve).toHaveBeenCalledTimes(3);
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
      // The money-integrity guard must fire on the FIRST read — a non-AUD settlement is a
      // permanent condition, so it must never be dragged into the retry window.
      expect(mockStripe.charges.retrieve).toHaveBeenCalledTimes(1);
    });
  });

  describe('retrievePaymentIntentStatus (reconcile pre-recharge check, FIX 6)', () => {
    it('returns the PI status with hardDeclined=false when there is no last_payment_error', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_r1',
        status: 'succeeded',
        amount: 10_000,
        currency: 'aud',
        latest_charge: { id: 'ch_1', refunded: false, amount_refunded: 0 },
      });
      const result = await retrievePaymentIntentStatus('pi_r1');
      expect(result).toEqual({
        status: 'succeeded',
        hardDeclined: false,
        refundedFully: false,
        amountRefundedMinor: 0,
        amountMinor: 10_000,
        currency: 'aud',
      });
      // READ-ONLY — it only retrieves; it never creates a charge.
      expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
    });

    it('EXPANDS latest_charge — a refund is invisible without it', async () => {
      // ⚠ A REFUND DOES NOT MOVE A PaymentIntent OFF `succeeded`. Nothing on an unexpanded
      // response says the money came back, so the auto-top-up reconcile would credit a wallet
      // whose charge had already been refunded by the operator answering its own alarm.
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_r1b',
        status: 'succeeded',
        amount: 10_000,
        currency: 'aud',
        latest_charge: { id: 'ch_1', refunded: false, amount_refunded: 0 },
      });

      await retrievePaymentIntentStatus('pi_r1b');

      expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_r1b', {
        expand: ['latest_charge'],
      });
    });

    it('reports refundedFully=true ONLY on Stripe`s own full-reversal flag (status is still `succeeded`)', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_r1c',
        status: 'succeeded',
        amount: 10_000,
        currency: 'aud',
        latest_charge: { id: 'ch_1', refunded: true, amount_refunded: 10_000 },
      });

      const result = await retrievePaymentIntentStatus('pi_r1c');

      expect(result).toMatchObject({
        status: 'succeeded',
        refundedFully: true,
        amountRefundedMinor: 10_000,
      });
    });

    it('reports a PARTIAL refund as refundedFully=false WITH the refunded amount (never as a full one)', async () => {
      // ⚠⚠ THE REGRESSION THIS REPLACES. This case used to be pinned as `refunded: true` under the
      // reasoning "any money back is money back". It is not: on an A$300 charge with an A$25
      // refund, A$275 is still money the customer paid and has not got back — and the auto-top-up
      // reconcile's terminal arm reads that boolean, drains the marker and credits NOTHING. One
      // lossy field silently destroyed A$275 of owed credit, unrecoverably. FULL and PARTIAL are
      // different facts and must arrive as different fields.
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_r1d',
        status: 'succeeded',
        amount: 30_000,
        currency: 'aud',
        latest_charge: { id: 'ch_1', refunded: false, amount_refunded: 2_500 },
      });

      expect(await retrievePaymentIntentStatus('pi_r1d')).toMatchObject({
        refundedFully: false,
        amountRefundedMinor: 2_500,
        amountMinor: 30_000,
      });
    });

    it('reports no refund at all when there is no charge yet (nothing to refund)', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_r1e',
        status: 'processing',
        amount: 10_000,
        currency: 'aud',
        latest_charge: null,
      });

      expect(await retrievePaymentIntentStatus('pi_r1e')).toMatchObject({
        refundedFully: false,
        amountRefundedMinor: 0,
      });
    });

    it('does NOT treat an unflagged full-value refund as terminal (only `charge.refunded` is)', async () => {
      // A charge whose `amount_refunded` has reached `amount` but whose `refunded` flag is not set
      // is not a state Stripe should produce — so it takes the PARTIAL path, where a human looks,
      // rather than the drain-without-credit path. Fail-safe by construction, not by luck.
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_r1d2',
        status: 'succeeded',
        amount: 10_000,
        currency: 'aud',
        latest_charge: { id: 'ch_1', refunded: false, amount_refunded: 10_000 },
      });

      expect(await retrievePaymentIntentStatus('pi_r1d2')).toMatchObject({
        refundedFully: false,
        amountRefundedMinor: 10_000,
      });
    });

    it('carries the CROSSING-TIME amount + currency off the PaymentIntent itself', async () => {
      // The failed notice must quote what was actually attempted, not a wallet column re-read at
      // sweep time (the company can change its reload between the charge and the reconcile).
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_r1f',
        status: 'canceled',
        amount: 7_500,
        currency: 'AUD',
        latest_charge: null,
      });

      expect(await retrievePaymentIntentStatus('pi_r1f')).toMatchObject({
        amountMinor: 7_500,
        currency: 'aud',
      });
    });

    it('flags a hard decline (a non-SCA last_payment_error)', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_r2',
        status: 'requires_payment_method',
        amount: 10_000,
        currency: 'aud',
        latest_charge: null,
        last_payment_error: { code: 'card_declined' },
      });
      const result = await retrievePaymentIntentStatus('pi_r2');
      expect(result).toMatchObject({ status: 'requires_payment_method', hardDeclined: true });
    });

    it('does NOT flag an SCA (authentication_required) prompt as a hard decline', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_r3',
        status: 'requires_action',
        amount: 10_000,
        currency: 'aud',
        latest_charge: null,
        last_payment_error: { code: 'authentication_required' },
      });
      const result = await retrievePaymentIntentStatus('pi_r3');
      expect(result).toMatchObject({ status: 'requires_action', hardDeclined: false });
    });

    it('returns null when the PaymentIntent cannot be retrieved', async () => {
      mockStripe.paymentIntents.retrieve.mockRejectedValue(new Error('stripe unavailable'));
      expect(await retrievePaymentIntentStatus('pi_r4')).toBeNull();
    });
  });

  describe('findPaymentIntentByIdempotencyKey (BAL-515 lost-charge recovery)', () => {
    const CREATED_AFTER = new Date('2026-09-03T10:00:00.000Z');
    const input = {
      customerId: 'cus_1',
      idempotencyKey: 'auto_topup:wallet_1:led_E',
      createdAfter: CREATED_AFTER,
    };

    it('⚠ LISTS, NEVER CREATES — a create under the same key would MINT a charge when none exists', async () => {
      mockStripe.paymentIntents.list.mockResolvedValue({ data: [], has_more: false });

      await findPaymentIntentByIdempotencyKey(input);

      expect(mockStripe.paymentIntents.create).not.toHaveBeenCalled();
      expect(mockStripe.paymentIntents.list).toHaveBeenCalledTimes(1);
    });

    it('bounds the scan by created[gte] = the marker time minus 60s of clock slack', async () => {
      mockStripe.paymentIntents.list.mockResolvedValue({ data: [], has_more: false });

      await findPaymentIntentByIdempotencyKey(input);

      expect(mockStripe.paymentIntents.list).toHaveBeenCalledWith({
        customer: 'cus_1',
        created: { gte: Math.floor(CREATED_AFTER.getTime() / 1000) - 60 },
        limit: 100,
      });
    });

    it('matches on metadata.idempotencyKey and returns the PaymentIntent id', async () => {
      mockStripe.paymentIntents.list.mockResolvedValue({
        data: [
          { id: 'pi_other', metadata: { idempotencyKey: 'auto_topup:wallet_1:led_OTHER' } },
          { id: 'pi_ours', metadata: { idempotencyKey: 'auto_topup:wallet_1:led_E' } },
        ],
        has_more: false,
      });

      expect(await findPaymentIntentByIdempotencyKey(input)).toEqual({
        found: true,
        paymentIntentId: 'pi_ours',
      });
    });

    it('a miss on a FULLY-listed page is EXHAUSTIVE — proof no charge was ever created', async () => {
      mockStripe.paymentIntents.list.mockResolvedValue({
        data: [{ id: 'pi_other', metadata: { idempotencyKey: 'something_else' } }],
        has_more: false,
      });

      expect(await findPaymentIntentByIdempotencyKey(input)).toEqual({
        found: false,
        exhaustive: true,
      });
    });

    it('a miss with has_more is NOT proof (the caller must not drain a marker on it)', async () => {
      mockStripe.paymentIntents.list.mockResolvedValue({ data: [], has_more: true });

      expect(await findPaymentIntentByIdempotencyKey(input)).toEqual({
        found: false,
        exhaustive: false,
      });
    });

    it('never throws — a Stripe fault reports INCONCLUSIVE, not "never created"', async () => {
      mockStripe.paymentIntents.list.mockRejectedValue(new Error('stripe unavailable'));

      expect(await findPaymentIntentByIdempotencyKey(input)).toEqual({
        found: false,
        exhaustive: false,
      });
    });
  });
});
