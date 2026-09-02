import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { CreditWallet } from '@balo/db';

const { mockFindById, mockApplyMandateStatus } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockApplyMandateStatus: vi.fn(),
}));

vi.mock('stripe', async () => (await import('../../test/mocks/stripe.js')).stripeMockModule());
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  creditWalletsRepository: { findById: mockFindById, applyMandateStatus: mockApplyMandateStatus },
  db: { __brand: 'mock-db' },
}));

import {
  attachPaymentMethod,
  confirmSavedCardMandate,
  createSetupIntent,
  ensureCustomer,
  retrieveCardDisplay,
} from './mandate.js';
import { mockStripe, resetStripeMock } from '../../test/mocks/stripe.js';

/** Minimal wallet fixture — the mandate service only reads `id` + `stripeCustomerId`. */
function walletFixture(overrides: Partial<CreditWallet>): CreditWallet {
  return { id: 'wallet_1', stripeCustomerId: null, ...overrides } as unknown as CreditWallet;
}

describe('mandate', () => {
  const originalKey = process.env.STRIPE_SECRET_KEY;

  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  });
  afterAll(() => {
    process.env.STRIPE_SECRET_KEY = originalKey;
  });
  beforeEach(() => {
    resetStripeMock();
    mockFindById.mockReset();
    mockApplyMandateStatus.mockReset();
  });

  describe('ensureCustomer', () => {
    it('returns the existing customer id without calling Stripe', async () => {
      const id = await ensureCustomer(walletFixture({ stripeCustomerId: 'cus_existing' }));
      expect(id).toBe('cus_existing');
      expect(mockStripe.customers.create).not.toHaveBeenCalled();
    });

    it('creates a customer with a stable idempotency key when none exists', async () => {
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });

      const id = await ensureCustomer(walletFixture({ id: 'wallet_9', stripeCustomerId: null }));

      expect(id).toBe('cus_new');
      expect(mockStripe.customers.create).toHaveBeenCalledWith(
        { metadata: { walletId: 'wallet_9' } },
        { idempotencyKey: 'stripe-customer-wallet_9' }
      );
    });

    it('re-throws when Stripe customer creation fails', async () => {
      mockStripe.customers.create.mockRejectedValue(new Error('stripe down'));
      await expect(ensureCustomer(walletFixture({ stripeCustomerId: null }))).rejects.toThrow(
        /stripe down/
      );
    });
  });

  describe('attachPaymentMethod', () => {
    it('attaches the payment method to the customer', async () => {
      mockStripe.paymentMethods.attach.mockResolvedValue({ id: 'pm_1' });
      await attachPaymentMethod('cus_1', 'pm_1');
      expect(mockStripe.paymentMethods.attach).toHaveBeenCalledWith('pm_1', { customer: 'cus_1' });
    });

    it('re-throws when the attach fails', async () => {
      mockStripe.paymentMethods.attach.mockRejectedValue(new Error('attach failed'));
      await expect(attachPaymentMethod('cus_1', 'pm_1')).rejects.toThrow(/attach failed/);
    });
  });

  describe('createSetupIntent', () => {
    it('ensures the customer, creates an off_session SetupIntent, and marks mandate pending', async () => {
      mockFindById.mockResolvedValue(walletFixture({ id: 'wallet_1', stripeCustomerId: null }));
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });
      mockStripe.setupIntents.create.mockResolvedValue({
        id: 'seti_1',
        client_secret: 'seti_1_secret',
      });

      const result = await createSetupIntent('wallet_1');

      expect(result).toEqual({
        clientSecret: 'seti_1_secret',
        setupIntentId: 'seti_1',
        customerId: 'cus_new',
      });
      expect(mockStripe.setupIntents.create).toHaveBeenCalledWith({
        customer: 'cus_new',
        usage: 'off_session',
        metadata: { walletId: 'wallet_1' },
      });
      expect(mockApplyMandateStatus).toHaveBeenCalledWith(
        { __brand: 'mock-db' },
        'wallet_1',
        'pending'
      );
    });

    it('reuses an already-stored customer id', async () => {
      mockFindById.mockResolvedValue(
        walletFixture({ id: 'wallet_1', stripeCustomerId: 'cus_existing' })
      );
      mockStripe.setupIntents.create.mockResolvedValue({
        id: 'seti_2',
        client_secret: 'seti_2_secret',
      });

      const result = await createSetupIntent('wallet_1');

      expect(result.customerId).toBe('cus_existing');
      expect(mockStripe.customers.create).not.toHaveBeenCalled();
      expect(mockStripe.setupIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_existing' })
      );
    });

    it('throws when the wallet does not exist', async () => {
      mockFindById.mockResolvedValue(undefined);
      await expect(createSetupIntent('missing')).rejects.toThrow(/not found/);
      expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();
    });

    it('throws when the SetupIntent has no client_secret', async () => {
      mockFindById.mockResolvedValue(walletFixture({ id: 'wallet_1', stripeCustomerId: 'cus_1' }));
      mockStripe.setupIntents.create.mockResolvedValue({ id: 'seti_3', client_secret: null });
      await expect(createSetupIntent('wallet_1')).rejects.toThrow(/client_secret/);
      expect(mockApplyMandateStatus).not.toHaveBeenCalled();
    });
  });

  describe('retrieveCardDisplay', () => {
    it('maps a card PaymentMethod to its four display fields', async () => {
      mockStripe.paymentMethods.retrieve.mockResolvedValue({
        id: 'pm_1',
        type: 'card',
        card: { brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2028 },
      });

      await expect(retrieveCardDisplay('pm_1')).resolves.toEqual({
        cardBrand: 'visa',
        cardLast4: '4242',
        cardExpMonth: 8,
        cardExpYear: 2028,
      });
    });

    it('returns null for a non-card payment method', async () => {
      mockStripe.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_2', type: 'au_becs_debit' });
      await expect(retrieveCardDisplay('pm_2')).resolves.toBeNull();
    });

    it('returns null for a card PaymentMethod with no card object', async () => {
      mockStripe.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_3', type: 'card' });
      await expect(retrieveCardDisplay('pm_3')).resolves.toBeNull();
    });

    it('returns null and does NOT throw when Stripe fails (a webhook 500 would retry a charge)', async () => {
      mockStripe.paymentMethods.retrieve.mockRejectedValue(new Error('stripe is down'));
      await expect(retrieveCardDisplay('pm_4')).resolves.toBeNull();
    });
  });

  describe('confirmSavedCardMandate', () => {
    const savedCardWallet = walletFixture({
      id: 'wallet_1',
      stripeCustomerId: 'cus_1',
      stripePaymentMethodId: 'pm_1',
    });

    it('confirms against the stored card and marks the wallet pending', async () => {
      mockFindById.mockResolvedValue(savedCardWallet);
      mockStripe.setupIntents.create.mockResolvedValue({
        id: 'seti_1',
        status: 'succeeded',
        client_secret: 'seti_1_secret',
      });

      await expect(confirmSavedCardMandate('wallet_1', 'req-1')).resolves.toEqual({
        status: 'succeeded',
        clientSecret: null,
      });
      expect(mockStripe.setupIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_1',
          payment_method: 'pm_1',
          usage: 'off_session',
          confirm: true,
          metadata: { walletId: 'wallet_1' },
        }),
        { idempotencyKey: 'mandate-confirm:wallet_1:req-1' }
      );
      expect(mockApplyMandateStatus).toHaveBeenCalledWith(
        { __brand: 'mock-db' },
        'wallet_1',
        'pending'
      );
    });

    it('never claims the buyer is absent — `off_session` is not passed to confirm', async () => {
      mockFindById.mockResolvedValue(savedCardWallet);
      mockStripe.setupIntents.create.mockResolvedValue({ id: 'seti_1', status: 'succeeded' });

      await confirmSavedCardMandate('wallet_1', 'req-1');

      const [params, options] = mockStripe.setupIntents.create.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      // `usage: 'off_session'` (what the mandate is FOR) is present; `off_session` (whether the
      // buyer is here) must NOT be — it would turn a completable 3DS into a hard failure.
      expect(params).not.toHaveProperty('off_session');
      expect(params.usage).toBe('off_session');
      // And the create is IDEMPOTENT on the purchase's clientRequestId — a retried Server
      // Action returns the same SetupIntent instead of minting duplicates, while the
      // composer's per-decline rotation still makes a genuinely new attempt a new intent.
      expect(options).toEqual({ idempotencyKey: 'mandate-confirm:wallet_1:req-1' });
    });

    it('returns the client secret for a 3DS challenge (requires_action)', async () => {
      mockFindById.mockResolvedValue(savedCardWallet);
      mockStripe.setupIntents.create.mockResolvedValue({
        id: 'seti_2',
        status: 'requires_action',
        client_secret: 'seti_2_secret',
      });

      await expect(confirmSavedCardMandate('wallet_1', 'req-1')).resolves.toEqual({
        status: 'requires_action',
        clientSecret: 'seti_2_secret',
      });
    });

    it('reports failed (never throws) when Stripe rejects the confirmation', async () => {
      mockFindById.mockResolvedValue(savedCardWallet);
      mockStripe.setupIntents.create.mockRejectedValue(new Error('card declined'));

      await expect(confirmSavedCardMandate('wallet_1', 'req-1')).resolves.toEqual({
        status: 'failed',
        clientSecret: null,
      });
    });

    it('reports failed for any other terminal SetupIntent status', async () => {
      mockFindById.mockResolvedValue(savedCardWallet);
      mockStripe.setupIntents.create.mockResolvedValue({
        id: 'seti_3',
        status: 'requires_payment_method',
        client_secret: 'seti_3_secret',
      });

      await expect(confirmSavedCardMandate('wallet_1', 'req-1')).resolves.toEqual({
        status: 'failed',
        clientSecret: null,
      });
    });

    it('throws when the wallet has no stored card to confirm against', async () => {
      mockFindById.mockResolvedValue(
        walletFixture({ id: 'wallet_1', stripeCustomerId: 'cus_1', stripePaymentMethodId: null })
      );
      await expect(confirmSavedCardMandate('wallet_1', 'req-1')).rejects.toThrow(/no stored card/);
      expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();
    });

    it('throws when the wallet does not exist', async () => {
      mockFindById.mockResolvedValue(undefined);
      await expect(confirmSavedCardMandate('missing', 'req-1')).rejects.toThrow(/not found/);
    });
  });
});
