import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockFindById = vi.fn();
vi.mock('@balo/db', () => ({
  creditWalletsRepository: { findById: (...args: unknown[]) => mockFindById(...args) },
}));

const mockEnsureCustomer = vi.fn();
const mockCreatePurchaseIntent = vi.fn();
const mockCreateSavedCardCharge = vi.fn();
vi.mock('../../services/stripe/index.js', () => ({
  ensureCustomer: (...args: unknown[]) => mockEnsureCustomer(...args),
  createOnSessionPurchaseIntent: (...args: unknown[]) => mockCreatePurchaseIntent(...args),
  createOnSessionSavedCardCharge: (...args: unknown[]) => mockCreateSavedCardCharge(...args),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { purchaseIntentRoute } from './purchase-intent.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';
const WALLET_ID = '550e8400-e29b-41d4-a716-446655440000';
const MEMBER_ID = '550e8400-e29b-41d4-a716-446655440001';
const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440002';

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    walletId: WALLET_ID,
    presentmentCurrency: 'AUD',
    presentmentAmountMinor: 100_000,
    initiatingMemberId: MEMBER_ID,
    clientRequestId: REQUEST_ID,
    ...overrides,
  };
}

describe('POST /credit/purchase-intent', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    app = Fastify({ logger: false });
    await app.register(purchaseIntentRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue({
      id: WALLET_ID,
      stripeCustomerId: null,
      stripePaymentMethodId: null,
    });
    mockEnsureCustomer.mockResolvedValue('cus_1');
    mockCreatePurchaseIntent.mockResolvedValue({
      clientSecret: 'pi_secret',
      paymentIntentId: 'pi_1',
    });
    mockCreateSavedCardCharge.mockResolvedValue({
      outcome: 'confirmed',
      status: 'succeeded',
      clientSecret: 'pi_secret',
      paymentIntentId: 'pi_saved',
    });
  });

  /** A wallet with a usable stored card (both Stripe ids present). */
  function savedCardWallet() {
    return { id: WALLET_ID, stripeCustomerId: 'cus_1', stripePaymentMethodId: 'pm_1' };
  }

  function inject(body?: Record<string, unknown>, headers?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/credit/purchase-intent',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body && { payload: body }),
    });
  }

  it('returns 401 when the x-internal-api-key header is missing', async () => {
    const res = await inject(validBody());
    expect(res.statusCode).toBe(401);
    expect(mockCreatePurchaseIntent).not.toHaveBeenCalled();
  });

  it('returns 401 when the internal key is wrong', async () => {
    const res = await inject(validBody(), { 'x-internal-api-key': 'nope' });
    expect(res.statusCode).toBe(401);
    expect(mockCreatePurchaseIntent).not.toHaveBeenCalled();
  });

  it('returns 400 when the body fails Zod validation (bad uuid)', async () => {
    const res = await inject(validBody({ walletId: 'not-a-uuid' }), {
      'x-internal-api-key': TEST_SECRET,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(mockCreatePurchaseIntent).not.toHaveBeenCalled();
  });

  it('returns 400 when the amount is below the A$300 floor (server-side bound)', async () => {
    const res = await inject(validBody({ presentmentAmountMinor: 29_999 }), {
      'x-internal-api-key': TEST_SECRET,
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreatePurchaseIntent).not.toHaveBeenCalled();
  });

  it('returns 400 when the amount is above the A$10,000 ceiling (server-side bound)', async () => {
    const res = await inject(validBody({ presentmentAmountMinor: 1_000_001 }), {
      'x-internal-api-key': TEST_SECRET,
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreatePurchaseIntent).not.toHaveBeenCalled();
  });

  it('returns 400 for a currency outside the allowlist', async () => {
    const res = await inject(validBody({ presentmentCurrency: 'jpy' }), {
      'x-internal-api-key': TEST_SECRET,
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreatePurchaseIntent).not.toHaveBeenCalled();
  });

  it('returns 404 when the wallet is not found', async () => {
    mockFindById.mockResolvedValue(undefined);
    const res = await inject(validBody(), { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('wallet_not_found');
    expect(mockCreatePurchaseIntent).not.toHaveBeenCalled();
  });

  it('lowercases the currency, builds the purchase idempotency key, and returns the client secret', async () => {
    const res = await inject(validBody({ promoCode: 'WELCOME50' }), {
      'x-internal-api-key': TEST_SECRET,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      outcome: 'needs_client_confirmation',
      clientSecret: 'pi_secret',
      paymentIntentId: 'pi_1',
    });
    // BAL-522 (D2) — `initiatingMemberId` is, despite the name, already a user id; it is now
    // also threaded to `ensureCustomer` as the seed actor.
    expect(mockEnsureCustomer).toHaveBeenCalledWith(
      {
        id: WALLET_ID,
        stripeCustomerId: null,
        stripePaymentMethodId: null,
      },
      { userId: MEMBER_ID }
    );
    expect(mockCreatePurchaseIntent).toHaveBeenCalledWith({
      walletId: WALLET_ID,
      customerId: 'cus_1',
      presentmentCurrency: 'aud',
      presentmentAmountMinor: 100_000,
      initiatingMemberId: MEMBER_ID,
      idempotencyKey: `purchase:${WALLET_ID}:new_card:${REQUEST_ID}`,
      promoCode: 'WELCOME50',
    });
    // The saved-card path is never touched by an unqualified (default) request.
    expect(mockCreateSavedCardCharge).not.toHaveBeenCalled();
  });

  describe('paymentMethodSource: saved_card', () => {
    const savedBody = () => validBody({ paymentMethodSource: 'saved_card' });

    it('returns 400 no_saved_card when the wallet has no stored card', async () => {
      // Default fixture: both Stripe ids null.
      const res = await inject(savedBody(), { 'x-internal-api-key': TEST_SECRET });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('no_saved_card');
      expect(mockCreateSavedCardCharge).not.toHaveBeenCalled();
    });

    it('returns 400 no_saved_card when only the customer id is stored (half a card)', async () => {
      mockFindById.mockResolvedValue({
        id: WALLET_ID,
        stripeCustomerId: 'cus_1',
        stripePaymentMethodId: null,
      });
      const res = await inject(savedBody(), { 'x-internal-api-key': TEST_SECRET });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('no_saved_card');
    });

    it('charges the stored card and reports complete on succeeded', async () => {
      mockFindById.mockResolvedValue(savedCardWallet());
      const res = await inject(savedBody(), { 'x-internal-api-key': TEST_SECRET });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: 'complete', paymentIntentId: 'pi_saved' });
      expect(mockCreateSavedCardCharge).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: WALLET_ID,
          customerId: 'cus_1',
          paymentMethodId: 'pm_1',
          presentmentCurrency: 'aud',
          presentmentAmountMinor: 100_000,
          initiatingMemberId: MEMBER_ID,
          // BAL-515 — the payment-method source is folded into the key ON THE SERVER, so the
          // two paths cannot collide even if a client reuses one request id across a switch.
          idempotencyKey: `purchase:${WALLET_ID}:saved_card:${REQUEST_ID}`,
        })
      );
      // The stored customer is used directly — no `ensureCustomer` round trip.
      expect(mockEnsureCustomer).not.toHaveBeenCalled();
    });

    it('BAL-515: the two sources derive DIFFERENT keys for the SAME clientRequestId (structural, not a client convention)', async () => {
      // ⚠ The two paths build PaymentIntents with DIFFERENT params (`saved_card` carries
      // `payment_method` + `confirm: true`), and Stripe 400s on one key reused with different
      // params. That used to hold only because the web composer re-minted `clientRequestId` on a
      // switch — a CLIENT-side convention protecting a SERVER-side guarantee.
      mockFindById.mockResolvedValue(savedCardWallet());
      await inject(savedBody(), { 'x-internal-api-key': TEST_SECRET });
      await inject(validBody(), { 'x-internal-api-key': TEST_SECRET });

      const savedKey = mockCreateSavedCardCharge.mock.calls[0]?.[0]?.idempotencyKey;
      const newKey = mockCreatePurchaseIntent.mock.calls[0]?.[0]?.idempotencyKey;
      expect(savedKey).toBe(`purchase:${WALLET_ID}:saved_card:${REQUEST_ID}`);
      expect(newKey).toBe(`purchase:${WALLET_ID}:new_card:${REQUEST_ID}`);
      expect(savedKey).not.toBe(newKey);
    });

    it('reports complete for a `processing` PaymentIntent (the webhook still credits)', async () => {
      mockFindById.mockResolvedValue(savedCardWallet());
      mockCreateSavedCardCharge.mockResolvedValue({
        outcome: 'confirmed',
        status: 'processing',
        clientSecret: 'pi_secret',
        paymentIntentId: 'pi_saved',
      });
      const res = await inject(savedBody(), { 'x-internal-api-key': TEST_SECRET });
      expect(res.json()).toEqual({ outcome: 'complete', paymentIntentId: 'pi_saved' });
    });

    it('returns the client secret for a 3DS challenge (requires_action)', async () => {
      mockFindById.mockResolvedValue(savedCardWallet());
      mockCreateSavedCardCharge.mockResolvedValue({
        outcome: 'confirmed',
        status: 'requires_action',
        clientSecret: 'pi_3ds_secret',
        paymentIntentId: 'pi_saved',
      });
      const res = await inject(savedBody(), { 'x-internal-api-key': TEST_SECRET });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        outcome: 'requires_action',
        clientSecret: 'pi_3ds_secret',
        paymentIntentId: 'pi_saved',
      });
    });

    it('returns 402 with the decline code when the card is refused', async () => {
      mockFindById.mockResolvedValue(savedCardWallet());
      mockCreateSavedCardCharge.mockResolvedValue({
        outcome: 'declined',
        code: 'insufficient_funds',
        paymentIntentId: 'pi_saved',
      });
      const res = await inject(savedBody(), { 'x-internal-api-key': TEST_SECRET });

      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ outcome: 'declined', code: 'insufficient_funds' });
    });

    it('returns 402 with a null code for any other terminal status', async () => {
      mockFindById.mockResolvedValue(savedCardWallet());
      mockCreateSavedCardCharge.mockResolvedValue({
        outcome: 'confirmed',
        status: 'canceled',
        clientSecret: 'pi_secret',
        paymentIntentId: 'pi_saved',
      });
      const res = await inject(savedBody(), { 'x-internal-api-key': TEST_SECRET });

      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ outcome: 'declined', code: null });
    });

    it('derives return_url from APP_URL and IGNORES any client-supplied value (R15)', async () => {
      process.env.APP_URL = 'https://app.balo.test';
      mockFindById.mockResolvedValue(savedCardWallet());

      const res = await inject(
        validBody({
          paymentMethodSource: 'saved_card',
          // A hostile caller trying to choose where Stripe bounces the buyer after 3DS.
          returnUrl: 'https://evil.example.com/steal',
          return_url: 'https://evil.example.com/steal',
        }),
        { 'x-internal-api-key': TEST_SECRET }
      );

      expect(res.statusCode).toBe(200);
      const [args] = mockCreateSavedCardCharge.mock.calls[0] as [{ returnUrl: string }];
      expect(args.returnUrl).toBe('https://app.balo.test/billing/top-up');
      expect(JSON.stringify(mockCreateSavedCardCharge.mock.calls)).not.toContain(
        'evil.example.com'
      );
      delete process.env.APP_URL;
    });

    it('returns 400 for an unknown paymentMethodSource', async () => {
      const res = await inject(validBody({ paymentMethodSource: 'bank_transfer' }), {
        'x-internal-api-key': TEST_SECRET,
      });
      expect(res.statusCode).toBe(400);
      expect(mockCreateSavedCardCharge).not.toHaveBeenCalled();
      expect(mockCreatePurchaseIntent).not.toHaveBeenCalled();
    });
  });
});
