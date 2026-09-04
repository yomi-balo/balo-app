import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { CreditWallet } from '@balo/db';

const {
  mockFindById,
  mockApplyMandateStatus,
  mockFindBillingIdentityById,
  mockSeedBillingEmail,
  mockFindEmailById,
  mockClearSavedCardAndReconcileMode,
  mockTransaction,
  mockHasActiveSessionForWallet,
  mockHasOpenReceivable,
  mockNotificationPublish,
  mockTrackServer,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockApplyMandateStatus: vi.fn(),
  mockFindBillingIdentityById: vi.fn(),
  mockSeedBillingEmail: vi.fn(),
  mockFindEmailById: vi.fn(),
  mockClearSavedCardAndReconcileMode: vi.fn(),
  mockTransaction: vi.fn((cb: (tx: unknown) => unknown) => cb({ __brand: 'mock-tx' })),
  mockHasActiveSessionForWallet: vi.fn(),
  mockHasOpenReceivable: vi.fn(),
  // BAL-521 §3 — `publishSavedCardDetached` (services/credit/saved-card-notify.ts) is NOT
  // mocked directly; it is a thin real wrapper over `notificationEvents.publish`, so mocking
  // THAT (the same module dispatch.test.ts mocks) exercises the real correlationId/mapping
  // logic while never touching a real BullMQ queue.
  mockNotificationPublish: vi.fn(),
  mockTrackServer: vi.fn(),
}));

vi.mock('stripe', async () => (await import('../../test/mocks/stripe.js')).stripeMockModule());
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  BILLING_SERVER_EVENTS: {
    EMAIL_SEEDED: 'billing_email_seeded',
    EMAIL_UPDATED: 'billing_email_updated',
  },
}));
vi.mock('@balo/db', () => ({
  creditWalletsRepository: {
    findById: mockFindById,
    applyMandateStatus: mockApplyMandateStatus,
    clearSavedCardAndReconcileMode: mockClearSavedCardAndReconcileMode,
  },
  // FIX ROUND (security MEDIUM) — the two `detachSavedCard` settlement-outstanding guards.
  creditSessionsRepository: { hasActiveSessionForWallet: mockHasActiveSessionForWallet },
  creditReceivablesRepository: { hasOpenReceivable: mockHasOpenReceivable },
  // BAL-522 — the billing-identity projection (step 1) + the seed attempt (step 2), never
  // `findNameById`/`findById`.
  companiesRepository: {
    findBillingIdentityById: mockFindBillingIdentityById,
    seedBillingEmail: mockSeedBillingEmail,
  },
  usersRepository: { findEmailById: mockFindEmailById },
  db: { __brand: 'mock-db', transaction: mockTransaction },
}));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockNotificationPublish },
}));

import {
  attachPaymentMethod,
  confirmSavedCardMandate,
  createSetupIntent,
  detachSavedCard,
  ensureCustomer,
  retrieveCardDisplay,
} from './mandate.js';
import { mockStripe, MockStripeError, resetStripeMock } from '../../test/mocks/stripe.js';

/** BAL-522 (D2) — the acting member on an `ensureCustomer` touch, in every default fixture. */
const ACTOR = { userId: 'user_1' };

/** FIX ROUND (security) — the per-request options `syncStripeCustomerIdentity` pins on its
 *  `customers.update` so a best-effort DISPLAY sync can never stall the money path on
 *  stripe-node's 80 s default × the client's `maxNetworkRetries: 2`. Asserted on every sync
 *  below: dropping them is a silent ~240 s purchase stall, not a cosmetic change. */
const SYNC_REQUEST_OPTIONS = { timeout: 5000, maxNetworkRetries: 0 };

/** BAL-522 — the default `findBillingIdentityById` row: a company with no billing email yet, so
 *  the default posture exercises the SEED arm unless a test overrides `billingEmail`. */
function billingIdentityFixture(
  overrides: Partial<{
    id: string;
    name: string;
    isPersonal: boolean;
    billingEmail: string | null;
    billingEmailSource: 'seeded' | 'set' | null;
    billingEmailSetByUserId: string | null;
    billingEmailSetAt: Date | null;
  }> = {}
) {
  return {
    id: 'company_1',
    name: 'Northwind Industrial',
    isPersonal: false,
    billingEmail: null,
    billingEmailSource: null,
    billingEmailSetByUserId: null,
    billingEmailSetAt: null,
    ...overrides,
  };
}

/**
 * Minimal wallet fixture — the mandate service only reads `id` + `stripeCustomerId` (plus, as of
 * BAL-521, `stripePaymentMethodId` / `cardBrand` / `cardLast4` for the post-commit notice's
 * `hadCard` gate). `cardBrand`/`cardLast4` default to `null` (never `undefined`) to match the
 * real DB row shape — Drizzle never omits a nullable column, and `undefined !== null` would
 * silently make every fixture "have a card".
 */
function walletFixture(overrides: Partial<CreditWallet>): CreditWallet {
  return {
    id: 'wallet_1',
    companyId: 'company_1',
    stripeCustomerId: null,
    cardBrand: null,
    cardLast4: null,
    ...overrides,
  } as unknown as CreditWallet;
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
    mockFindBillingIdentityById.mockReset();
    mockFindBillingIdentityById.mockResolvedValue(billingIdentityFixture());
    mockSeedBillingEmail.mockReset();
    mockSeedBillingEmail.mockResolvedValue({
      seeded: true,
      billingEmail: 'dana@northwind.test',
      auditEventId: 'audit_1',
    });
    mockFindEmailById.mockReset();
    mockFindEmailById.mockResolvedValue({ id: 'user_1', email: 'dana@northwind.test' });
    mockClearSavedCardAndReconcileMode.mockReset();
    mockTransaction.mockReset();
    mockTransaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb({ __brand: 'mock-tx' })
    );
    mockHasActiveSessionForWallet.mockReset();
    mockHasActiveSessionForWallet.mockResolvedValue(false);
    mockHasOpenReceivable.mockReset();
    mockHasOpenReceivable.mockResolvedValue(false);
    mockNotificationPublish.mockReset();
    mockTrackServer.mockReset();
  });

  describe('ensureCustomer', () => {
    // ★ THE LOAD-BEARING TEST — see this file's header comment for the revert-proof.
    it('a wallet WITH a stripeCustomerId and a null billing_email still seeds and still syncs', async () => {
      mockFindBillingIdentityById.mockResolvedValue(billingIdentityFixture({ billingEmail: null }));
      mockStripe.customers.update.mockResolvedValue({ id: 'cus_existing' });

      const id = await ensureCustomer(walletFixture({ stripeCustomerId: 'cus_existing' }), ACTOR);

      expect(id).toBe('cus_existing');
      expect(mockStripe.customers.create).not.toHaveBeenCalled();
      expect(mockSeedBillingEmail).toHaveBeenCalledWith({
        companyId: 'company_1',
        email: 'dana@northwind.test',
        actorUserId: 'user_1',
      });
      expect(mockStripe.customers.update).toHaveBeenCalledWith(
        'cus_existing',
        { name: 'Northwind Industrial', email: 'dana@northwind.test' },
        SYNC_REQUEST_OPTIONS
      );
    });

    it('creates the customer with exactly { metadata: { walletId } } and the stable key — no name, no email', async () => {
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });

      const id = await ensureCustomer(
        walletFixture({ id: 'wallet_9', stripeCustomerId: null }),
        ACTOR
      );

      expect(id).toBe('cus_new');
      expect(mockStripe.customers.create).toHaveBeenCalledWith(
        { metadata: { walletId: 'wallet_9' } },
        { idempotencyKey: 'stripe-customer-wallet_9' }
      );
    });

    it('the identity sync runs immediately after a create', async () => {
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });
      mockStripe.customers.update.mockResolvedValue({ id: 'cus_new' });

      await ensureCustomer(walletFixture({ id: 'wallet_9', stripeCustomerId: null }), ACTOR);

      expect(mockStripe.customers.update).toHaveBeenCalledWith(
        'cus_new',
        expect.objectContaining({ name: 'Northwind Industrial' }),
        SYNC_REQUEST_OPTIONS
      );
      const createOrder = mockStripe.customers.create.mock.invocationCallOrder[0];
      const updateOrder = mockStripe.customers.update.mock.invocationCallOrder[0];
      expect(createOrder).toBeLessThan(updateOrder as number);
    });

    it('seeds when the address is null and the actor holds MANAGE_BILLING', async () => {
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });

      await ensureCustomer(walletFixture({ id: 'wallet_9', stripeCustomerId: null }), ACTOR);

      expect(mockSeedBillingEmail).toHaveBeenCalledWith({
        companyId: 'company_1',
        email: 'dana@northwind.test',
        actorUserId: 'user_1',
      });
      expect(mockStripe.customers.update).toHaveBeenCalledWith(
        'cus_new',
        expect.objectContaining({ email: 'dana@northwind.test' }),
        SYNC_REQUEST_OPTIONS
      );
      expect(mockTrackServer).toHaveBeenCalledWith('billing_email_seeded', {
        company_id: 'company_1',
        company_is_personal: false,
        distinct_id: 'company_1',
      });
    });

    it('skips the seed for a platform-role actor', async () => {
      mockSeedBillingEmail.mockResolvedValue({
        seeded: false,
        reason: 'no_capability',
        billingEmail: null,
      });
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });

      await ensureCustomer(walletFixture({ id: 'wallet_9', stripeCustomerId: null }), ACTOR);

      expect(mockStripe.customers.update).toHaveBeenCalledWith(
        'cus_new',
        { name: 'Northwind Industrial' },
        SYNC_REQUEST_OPTIONS
      );
      expect(mockTrackServer).not.toHaveBeenCalled();
    });

    // FIX ROUND (security) — this used to assert the OPPOSITE ("a seed-write failure still puts
    // the actor's address on this touch's sync"). The MANAGE_BILLING gate lives INSIDE
    // `seedBillingEmail`'s transaction, so a throw means it never resolved — syncing the actor's
    // address anyway wrote to Stripe a value no capability check ever approved.
    it('a seed-write failure syncs the NAME ONLY — the unproven actor address never reaches Stripe', async () => {
      mockSeedBillingEmail.mockRejectedValue(new Error('db down'));
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });

      const id = await ensureCustomer(
        walletFixture({ id: 'wallet_9', stripeCustomerId: null }),
        ACTOR
      );

      expect(id).toBe('cus_new');
      expect(mockStripe.customers.update).toHaveBeenCalledWith(
        'cus_new',
        { name: 'Northwind Industrial' },
        SYNC_REQUEST_OPTIONS
      );
      // Non-vacuity floor — `email` is ABSENT, not present-and-null.
      const [, params] = mockStripe.customers.update.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect('email' in params).toBe(false);
    });

    it('an already-set billing email is synced and never re-seeded', async () => {
      mockFindBillingIdentityById.mockResolvedValue(
        billingIdentityFixture({
          billingEmail: 'billing@northwind.test',
          billingEmailSource: 'set',
        })
      );

      const id = await ensureCustomer(walletFixture({ stripeCustomerId: 'cus_existing' }), ACTOR);

      expect(id).toBe('cus_existing');
      expect(mockSeedBillingEmail).not.toHaveBeenCalled();
      expect(mockStripe.customers.update).toHaveBeenCalledWith(
        'cus_existing',
        { name: 'Northwind Industrial', email: 'billing@northwind.test' },
        SYNC_REQUEST_OPTIONS
      );
    });

    it('a company-read failure skips both the seed and the sync but still creates the customer', async () => {
      mockFindBillingIdentityById.mockRejectedValue(new Error('db down'));
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });

      const id = await ensureCustomer(
        walletFixture({ id: 'wallet_9', stripeCustomerId: null }),
        ACTOR
      );

      expect(id).toBe('cus_new');
      expect(mockSeedBillingEmail).not.toHaveBeenCalled();
      expect(mockStripe.customers.update).not.toHaveBeenCalled();
      expect(mockStripe.customers.create).toHaveBeenCalledWith(
        { metadata: { walletId: 'wallet_9' } },
        { idempotencyKey: 'stripe-customer-wallet_9' }
      );
    });

    it('a sync failure never throws into the money path', async () => {
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });
      mockStripe.customers.update.mockRejectedValue(new Error('stripe down'));

      const id = await ensureCustomer(
        walletFixture({ id: 'wallet_9', stripeCustomerId: null }),
        ACTOR
      );

      expect(id).toBe('cus_new');
      // Non-vacuity floor — the sync really was attempted (and really did fail).
      expect(mockStripe.customers.update).toHaveBeenCalledTimes(1);
    });

    it('re-throws when Stripe customer creation fails', async () => {
      mockStripe.customers.create.mockRejectedValue(new Error('stripe down'));
      await expect(
        ensureCustomer(walletFixture({ stripeCustomerId: null }), ACTOR)
      ).rejects.toThrow(/stripe down/);
    });

    it('skips the seed (and syncs with no email) when the actor read throws', async () => {
      mockFindEmailById.mockRejectedValue(new Error('db down'));
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });

      const id = await ensureCustomer(
        walletFixture({ id: 'wallet_9', stripeCustomerId: null }),
        ACTOR
      );

      expect(id).toBe('cus_new');
      expect(mockSeedBillingEmail).not.toHaveBeenCalled();
      expect(mockStripe.customers.update).toHaveBeenCalledWith(
        'cus_new',
        { name: 'Northwind Industrial' },
        SYNC_REQUEST_OPTIONS
      );
    });

    it('skips the seed (and syncs with no email) when the actor has no live account', async () => {
      mockFindEmailById.mockResolvedValue(undefined);
      mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });

      await ensureCustomer(walletFixture({ id: 'wallet_9', stripeCustomerId: null }), ACTOR);

      expect(mockSeedBillingEmail).not.toHaveBeenCalled();
      expect(mockStripe.customers.update).toHaveBeenCalledWith(
        'cus_new',
        { name: 'Northwind Industrial' },
        SYNC_REQUEST_OPTIONS
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

      const result = await createSetupIntent('wallet_1', ACTOR.userId);

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
        expect.objectContaining({ __brand: 'mock-db' }),
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

      const result = await createSetupIntent('wallet_1', ACTOR.userId);

      expect(result.customerId).toBe('cus_existing');
      expect(mockStripe.customers.create).not.toHaveBeenCalled();
      expect(mockStripe.setupIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_existing' })
      );
    });

    it('throws when the wallet does not exist', async () => {
      mockFindById.mockResolvedValue(undefined);
      await expect(createSetupIntent('missing', ACTOR.userId)).rejects.toThrow(/not found/);
      expect(mockStripe.setupIntents.create).not.toHaveBeenCalled();
    });

    it('throws when the SetupIntent has no client_secret', async () => {
      mockFindById.mockResolvedValue(walletFixture({ id: 'wallet_1', stripeCustomerId: 'cus_1' }));
      mockStripe.setupIntents.create.mockResolvedValue({ id: 'seti_3', client_secret: null });
      await expect(createSetupIntent('wallet_1', ACTOR.userId)).rejects.toThrow(/client_secret/);
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
        expect.objectContaining({ __brand: 'mock-db' }),
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

  describe('detachSavedCard', () => {
    const cardWallet = walletFixture({
      id: 'wallet_1',
      stripePaymentMethodId: 'pm_1',
      cardBrand: 'visa',
      cardLast4: '4242',
    });
    const ACTOR_USER_ID = 'user_1';

    it('refuses with settlement_outstanding — never touching Stripe — when the wallet has a live overdraft session (security MEDIUM)', async () => {
      mockFindById.mockResolvedValue(cardWallet);
      mockHasActiveSessionForWallet.mockResolvedValue(true);

      await expect(detachSavedCard('wallet_1', ACTOR_USER_ID)).resolves.toEqual({
        status: 'settlement_outstanding',
      });
      expect(mockStripe.paymentMethods.detach).not.toHaveBeenCalled();
      expect(mockClearSavedCardAndReconcileMode).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('refuses with settlement_outstanding when the company has an open receivable (security MEDIUM)', async () => {
      mockFindById.mockResolvedValue(cardWallet);
      mockHasOpenReceivable.mockResolvedValue(true);

      await expect(detachSavedCard('wallet_1', ACTOR_USER_ID)).resolves.toEqual({
        status: 'settlement_outstanding',
      });
      expect(mockStripe.paymentMethods.detach).not.toHaveBeenCalled();
      expect(mockClearSavedCardAndReconcileMode).not.toHaveBeenCalled();
      expect(mockHasOpenReceivable).toHaveBeenCalledWith(cardWallet.companyId);
    });

    it('treats a resource_missing probe failure as already-detached — the PM genuinely no longer exists at Stripe (review MINOR)', async () => {
      mockFindById.mockResolvedValue(cardWallet);
      mockStripe.paymentMethods.detach.mockRejectedValue(new Error('not attached'));
      const missingErr = new MockStripeError('No such payment method');
      missingErr.code = 'resource_missing';
      mockStripe.paymentMethods.retrieve.mockRejectedValue(missingErr);
      mockClearSavedCardAndReconcileMode.mockResolvedValue({
        wallet: { ...cardWallet, lowBalanceMode: 'notify_only' },
        modeReconciled: false,
        auditEventId: 'audit_1',
        previousLowBalanceMode: 'notify_only',
      });

      await expect(detachSavedCard('wallet_1', ACTOR_USER_ID)).resolves.toEqual({
        status: 'removed',
        lowBalanceMode: 'notify_only',
        modeReconciled: false,
      });
      expect(mockClearSavedCardAndReconcileMode).toHaveBeenCalled();
    });

    it('(B15) detaches at Stripe, then clears + reconciles inside one transaction, calling the primitive with EXACTLY {actorUserId, source: "user_initiated"}', async () => {
      mockFindById.mockResolvedValue(cardWallet);
      mockStripe.paymentMethods.detach.mockResolvedValue({ id: 'pm_1', customer: null });
      mockClearSavedCardAndReconcileMode.mockResolvedValue({
        wallet: { ...cardWallet, lowBalanceMode: 'notify_only' },
        modeReconciled: true,
        auditEventId: 'audit_1',
        previousLowBalanceMode: 'auto_topup',
      });

      await expect(detachSavedCard('wallet_1', ACTOR_USER_ID)).resolves.toEqual({
        status: 'removed',
        lowBalanceMode: 'notify_only',
        modeReconciled: true,
      });

      expect(mockStripe.paymentMethods.detach).toHaveBeenCalledWith('pm_1');
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockClearSavedCardAndReconcileMode).toHaveBeenCalledWith(
        { __brand: 'mock-tx' },
        'wallet_1',
        { actorUserId: ACTOR_USER_ID, source: 'user_initiated' }
      );
    });

    it('(B16) publishes credit.saved_card.detached with source, detachedByUserId, the PRE-CLEAR card label, and the audit-row-id correlationId', async () => {
      mockFindById.mockResolvedValue(cardWallet);
      mockStripe.paymentMethods.detach.mockResolvedValue({ id: 'pm_1', customer: null });
      mockClearSavedCardAndReconcileMode.mockResolvedValue({
        wallet: { ...cardWallet, lowBalanceMode: 'notify_only' },
        modeReconciled: true,
        auditEventId: 'audit_42',
        previousLowBalanceMode: 'keep_going',
      });

      await detachSavedCard('wallet_1', ACTOR_USER_ID);

      expect(mockNotificationPublish).toHaveBeenCalledTimes(1);
      const [event, payload] = mockNotificationPublish.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(event).toBe('credit.saved_card.detached');
      expect(payload).toMatchObject({
        correlationId: 'saved-card-detached.wallet_1.audit_42',
        companyId: 'company_1',
        walletId: 'wallet_1',
        source: 'user_initiated',
        modeReconciled: true,
        previousLowBalanceMode: 'keep_going',
        // The PRE-CLEAR label — cardWallet's cardBrand/cardLast4, not anything the (already
        // nulled) returned row could supply.
        cardBrand: 'visa',
        cardLast4: '4242',
        detachedByUserId: ACTOR_USER_ID,
      });
      expect(payload.userId).toBeUndefined();
    });

    it('(B17, PIN) a wallet that held NO card publishes NOTHING — the audit row is still written (a record, not a claim)', async () => {
      const cardlessWallet = walletFixture({ id: 'wallet_1', stripePaymentMethodId: null });
      mockFindById.mockResolvedValue(cardlessWallet);
      mockClearSavedCardAndReconcileMode.mockResolvedValue({
        wallet: { ...cardlessWallet, lowBalanceMode: 'notify_only' },
        modeReconciled: false,
        auditEventId: 'audit_repeat',
        previousLowBalanceMode: 'notify_only',
      });

      await detachSavedCard('wallet_1', ACTOR_USER_ID);

      expect(mockClearSavedCardAndReconcileMode).toHaveBeenCalled();
      expect(mockNotificationPublish).not.toHaveBeenCalled();
    });

    it('(B18) a publish failure does NOT fail the removal — detachSavedCard still resolves', async () => {
      mockFindById.mockResolvedValue(cardWallet);
      mockStripe.paymentMethods.detach.mockResolvedValue({ id: 'pm_1', customer: null });
      mockClearSavedCardAndReconcileMode.mockResolvedValue({
        wallet: { ...cardWallet, lowBalanceMode: 'notify_only' },
        modeReconciled: true,
        auditEventId: 'audit_1',
        previousLowBalanceMode: 'auto_topup',
      });
      mockNotificationPublish.mockRejectedValueOnce(new Error('queue unavailable'));

      await expect(detachSavedCard('wallet_1', ACTOR_USER_ID)).resolves.toEqual({
        status: 'removed',
        lowBalanceMode: 'notify_only',
        modeReconciled: true,
      });
    });

    it('treats a failed detach as already-done when the probe shows no customer', async () => {
      mockFindById.mockResolvedValue(cardWallet);
      mockStripe.paymentMethods.detach.mockRejectedValue(new Error('not attached'));
      mockStripe.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_1', customer: null });
      mockClearSavedCardAndReconcileMode.mockResolvedValue({
        wallet: { ...cardWallet, lowBalanceMode: 'notify_only' },
        modeReconciled: false,
        auditEventId: 'audit_1',
        previousLowBalanceMode: 'notify_only',
      });

      await expect(detachSavedCard('wallet_1', ACTOR_USER_ID)).resolves.toEqual({
        status: 'removed',
        lowBalanceMode: 'notify_only',
        modeReconciled: false,
      });
      expect(mockStripe.paymentMethods.retrieve).toHaveBeenCalledWith('pm_1');
      expect(mockClearSavedCardAndReconcileMode).toHaveBeenCalled();
    });

    it('reports stripe_error and never writes locally when the probe shows it is still attached', async () => {
      mockFindById.mockResolvedValue(cardWallet);
      mockStripe.paymentMethods.detach.mockRejectedValue(new Error('network blip'));
      mockStripe.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_1', customer: 'cus_1' });

      await expect(detachSavedCard('wallet_1', ACTOR_USER_ID)).resolves.toEqual({
        status: 'stripe_error',
      });
      expect(mockClearSavedCardAndReconcileMode).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('reports stripe_error when the probe itself throws', async () => {
      mockFindById.mockResolvedValue(cardWallet);
      mockStripe.paymentMethods.detach.mockRejectedValue(new Error('network blip'));
      mockStripe.paymentMethods.retrieve.mockRejectedValue(new Error('stripe is down'));

      await expect(detachSavedCard('wallet_1', ACTOR_USER_ID)).resolves.toEqual({
        status: 'stripe_error',
      });
      expect(mockClearSavedCardAndReconcileMode).not.toHaveBeenCalled();
    });

    it('skips Stripe entirely when there is no stored payment method, but still runs the transaction', async () => {
      mockFindById.mockResolvedValue(
        walletFixture({ id: 'wallet_1', stripePaymentMethodId: null })
      );
      mockClearSavedCardAndReconcileMode.mockResolvedValue({
        wallet: { ...cardWallet, lowBalanceMode: 'notify_only' },
        modeReconciled: false,
        auditEventId: 'audit_1',
        previousLowBalanceMode: 'notify_only',
      });

      await expect(detachSavedCard('wallet_1', ACTOR_USER_ID)).resolves.toEqual({
        status: 'removed',
        lowBalanceMode: 'notify_only',
        modeReconciled: false,
      });
      expect(mockStripe.paymentMethods.detach).not.toHaveBeenCalled();
      expect(mockClearSavedCardAndReconcileMode).toHaveBeenCalled();
      // The FINDBY'd wallet has no card — no notice, even though the primitive was called.
      expect(mockNotificationPublish).not.toHaveBeenCalled();
    });

    it('returns no_wallet when the wallet does not exist', async () => {
      mockFindById.mockResolvedValue(undefined);
      await expect(detachSavedCard('missing', ACTOR_USER_ID)).resolves.toEqual({
        status: 'no_wallet',
      });
      expect(mockStripe.paymentMethods.detach).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('propagates the error (for the route to 500) when the local write fails after a successful detach', async () => {
      mockFindById.mockResolvedValue(cardWallet);
      mockStripe.paymentMethods.detach.mockResolvedValue({ id: 'pm_1', customer: null });
      mockClearSavedCardAndReconcileMode.mockRejectedValue(new Error('db down'));

      await expect(detachSavedCard('wallet_1', ACTOR_USER_ID)).rejects.toThrow(/db down/);
    });
  });
});
