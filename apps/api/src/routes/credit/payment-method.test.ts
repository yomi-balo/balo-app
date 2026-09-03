import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockDetachSavedCard = vi.fn();
vi.mock('../../services/stripe/index.js', () => ({
  detachSavedCard: (...args: unknown[]) => mockDetachSavedCard(...args),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { paymentMethodRoute } from './payment-method.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';
const WALLET_ID = '550e8400-e29b-41d4-a716-446655440000';
const ACTOR_USER_ID = '660e8400-e29b-41d4-a716-446655440001';

describe('POST /credit/payment-method/detach', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    app = Fastify({ logger: false });
    await app.register(paymentMethodRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function inject(body?: Record<string, unknown>, headers?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/credit/payment-method/detach',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body && { payload: body }),
    });
  }

  it('returns 401 when the x-internal-api-key header is missing', async () => {
    const res = await inject({ walletId: WALLET_ID, actorUserId: ACTOR_USER_ID });
    expect(res.statusCode).toBe(401);
    expect(mockDetachSavedCard).not.toHaveBeenCalled();
  });

  it('returns 401 when the internal key is wrong', async () => {
    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': 'nope' }
    );
    expect(res.statusCode).toBe(401);
    expect(mockDetachSavedCard).not.toHaveBeenCalled();
  });

  it('returns 400 when walletId is not a uuid', async () => {
    const res = await inject(
      { walletId: 'not-a-uuid', actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(mockDetachSavedCard).not.toHaveBeenCalled();
  });

  // FIX ROUND 3 (N2) — the actor is now a required, validated field on the body: a route caller
  // that omits it (or sends a non-uuid) must be rejected structurally, the same as a bad
  // walletId, rather than silently falling through to an `undefined` actor at the service layer.
  it('returns 400 when actorUserId is missing', async () => {
    const res = await inject({ walletId: WALLET_ID }, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(mockDetachSavedCard).not.toHaveBeenCalled();
  });

  it('returns 400 when actorUserId is not a uuid', async () => {
    const res = await inject(
      { walletId: WALLET_ID, actorUserId: 'not-a-uuid' },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(mockDetachSavedCard).not.toHaveBeenCalled();
  });

  it('returns 404 when the wallet does not exist', async () => {
    mockDetachSavedCard.mockResolvedValue({ status: 'no_wallet' });
    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'wallet_not_found' });
  });

  it('returns 409 when the wallet has unsettled consultation time (security MEDIUM)', async () => {
    mockDetachSavedCard.mockResolvedValue({ status: 'settlement_outstanding' });
    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'settlement_outstanding' });
  });

  it('returns 502 when the Stripe detach fails', async () => {
    mockDetachSavedCard.mockResolvedValue({ status: 'stripe_error' });
    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'stripe_detach_failed' });
  });

  it('returns 200 with the effective low-balance mode on success, and threads actorUserId through', async () => {
    mockDetachSavedCard.mockResolvedValue({
      status: 'removed',
      lowBalanceMode: 'notify_only',
      modeReconciled: true,
    });
    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      removed: true,
      lowBalanceMode: 'notify_only',
      modeReconciled: true,
    });
    expect(mockDetachSavedCard).toHaveBeenCalledWith(WALLET_ID, ACTOR_USER_ID);
  });
});
