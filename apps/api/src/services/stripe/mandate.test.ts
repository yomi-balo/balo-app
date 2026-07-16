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

import { attachPaymentMethod, createSetupIntent, ensureCustomer } from './mandate.js';
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
});
