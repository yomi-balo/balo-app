import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockFindById = vi.fn();
vi.mock('@balo/db', () => ({
  creditWalletsRepository: { findById: (...args: unknown[]) => mockFindById(...args) },
}));

const mockEnsureCustomer = vi.fn();
const mockCreatePurchaseIntent = vi.fn();
vi.mock('../../services/stripe/index.js', () => ({
  ensureCustomer: (...args: unknown[]) => mockEnsureCustomer(...args),
  createOnSessionPurchaseIntent: (...args: unknown[]) => mockCreatePurchaseIntent(...args),
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
    mockFindById.mockResolvedValue({ id: WALLET_ID, stripeCustomerId: null });
    mockEnsureCustomer.mockResolvedValue('cus_1');
    mockCreatePurchaseIntent.mockResolvedValue({
      clientSecret: 'pi_secret',
      paymentIntentId: 'pi_1',
    });
  });

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
    expect(res.json()).toEqual({ clientSecret: 'pi_secret', paymentIntentId: 'pi_1' });
    expect(mockEnsureCustomer).toHaveBeenCalledWith({ id: WALLET_ID, stripeCustomerId: null });
    expect(mockCreatePurchaseIntent).toHaveBeenCalledWith({
      walletId: WALLET_ID,
      customerId: 'cus_1',
      presentmentCurrency: 'aud',
      presentmentAmountMinor: 100_000,
      initiatingMemberId: MEMBER_ID,
      idempotencyKey: `purchase:${WALLET_ID}:${REQUEST_ID}`,
      promoCode: 'WELCOME50',
    });
  });
});
