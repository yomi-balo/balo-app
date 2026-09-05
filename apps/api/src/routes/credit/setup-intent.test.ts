import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockCreateSetupIntent = vi.fn();
const mockConfirmSavedCardMandate = vi.fn();
vi.mock('../../services/stripe/index.js', () => ({
  createSetupIntent: (...args: unknown[]) => mockCreateSetupIntent(...args),
  confirmSavedCardMandate: (...args: unknown[]) => mockConfirmSavedCardMandate(...args),
}));

// BAL-527 — the route now calls `enforceMandateSetupRateLimit`, which calls `getRedis()`. This
// suite previously mocked NEITHER `redis.js` nor `rate-limiter.js`, so `getRedis()` would throw
// without `REDIS_URL` and every currently-passing case that reaches the handler would fail.
const { mockCheckRateLimit } = vi.hoisted(() => ({ mockCheckRateLimit: vi.fn() }));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}), createRedisConnection: () => ({}) }));
// ⚠ SPREAD THE REAL MODULE. A `() => ({ checkRateLimit })` factory silently drops
// `RATE_LIMIT_DEADLINE_MS` and the type export — the trap `end.test.ts` documents.
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { setupIntentRoute } from './setup-intent.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';
const WALLET_ID = '550e8400-e29b-41d4-a716-446655440000';
const ACTOR_USER_ID = '550e8400-e29b-41d4-a716-446655440099';

describe('POST /credit/setup-intent', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    app = Fastify({ logger: false });
    await app.register(setupIntentRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSetupIntent.mockResolvedValue({
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_1',
      customerId: 'cus_1',
    });
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 3600 });
  });

  function inject(body?: Record<string, unknown>, headers?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/credit/setup-intent',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body && { payload: body }),
    });
  }

  it('returns 401 when the x-internal-api-key header is missing', async () => {
    const res = await inject({ walletId: WALLET_ID });
    expect(res.statusCode).toBe(401);
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('returns 401 when the internal key is wrong', async () => {
    const res = await inject({ walletId: WALLET_ID }, { 'x-internal-api-key': 'nope' });
    expect(res.statusCode).toBe(401);
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('returns 400 when walletId is not a uuid', async () => {
    const res = await inject(
      { walletId: 'not-a-uuid', actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  // BAL-522 (D2) — `actorUserId` is REQUIRED, not optional: an omitted actor would make the
  // billing-email seed silently never happen on this path.
  it('returns 400 when actorUserId is missing', async () => {
    const res = await inject({ walletId: WALLET_ID }, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('creates the SetupIntent and returns the client secret + ids', async () => {
    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_1',
      customerId: 'cus_1',
    });
    expect(mockCreateSetupIntent).toHaveBeenCalledWith(WALLET_ID, ACTOR_USER_ID);
    expect(mockConfirmSavedCardMandate).not.toHaveBeenCalled();
  });

  it('rejects saved_card WITHOUT a clientRequestId — the SetupIntent create must be keyed', async () => {
    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID, paymentMethodSource: 'saved_card' },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(400);
    expect(mockConfirmSavedCardMandate).not.toHaveBeenCalled();
  });

  it('rejects saved_card WITHOUT an actorUserId — the field stays required for every arm', async () => {
    const res = await inject(
      {
        walletId: WALLET_ID,
        paymentMethodSource: 'saved_card',
        clientRequestId: '22222222-2222-4222-8222-222222222222',
      },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(400);
    expect(mockConfirmSavedCardMandate).not.toHaveBeenCalled();
  });

  it('confirms the mandate against the STORED card when paymentMethodSource is saved_card', async () => {
    mockConfirmSavedCardMandate.mockResolvedValue({ status: 'succeeded', clientSecret: null });
    const res = await inject(
      {
        walletId: WALLET_ID,
        actorUserId: ACTOR_USER_ID,
        paymentMethodSource: 'saved_card',
        clientRequestId: '22222222-2222-4222-8222-222222222222',
      },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'succeeded', clientSecret: null });
    // The `saved_card` arm does not reach `ensureCustomer` today, so `confirmSavedCardMandate`
    // itself takes no actor — the field stays required on the SCHEMA only, for a future arm.
    expect(mockConfirmSavedCardMandate).toHaveBeenCalledWith(
      WALLET_ID,
      '22222222-2222-4222-8222-222222222222'
    );
    // The buyer already gave us this card — never make them re-enter it.
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('returns the client secret when the stored-card mandate needs 3DS', async () => {
    mockConfirmSavedCardMandate.mockResolvedValue({
      status: 'requires_action',
      clientSecret: 'seti_3ds_secret',
    });
    const res = await inject(
      {
        walletId: WALLET_ID,
        actorUserId: ACTOR_USER_ID,
        paymentMethodSource: 'saved_card',
        clientRequestId: '22222222-2222-4222-8222-222222222222',
      },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.json()).toEqual({ status: 'requires_action', clientSecret: 'seti_3ds_secret' });
  });

  // ── BAL-527 — the per-wallet rate limit ───────────────────────────────────

  it('C1 — new_card over the limit: 429, and createSetupIntent is never called', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 31, ttlSeconds: 900 });

    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'rate_limited', cooldownSeconds: 900 });
    expect(res.headers['retry-after']).toBe('900');
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('C2 — saved_card over the limit: 429, and confirmSavedCardMandate is never called (pins the deliberate both-arms widening)', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 31, ttlSeconds: 900 });

    const res = await inject(
      {
        walletId: WALLET_ID,
        actorUserId: ACTOR_USER_ID,
        paymentMethodSource: 'saved_card',
        clientRequestId: '22222222-2222-4222-8222-222222222222',
      },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(429);
    expect(mockConfirmSavedCardMandate).not.toHaveBeenCalled();
  });

  it('C3 — Redis fails: 503, and neither service is called', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('redis unreachable'));

    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
    expect(mockConfirmSavedCardMandate).not.toHaveBeenCalled();
  });

  it('C4 — the bucket is keyed on walletId, never actorUserId or an ip', async () => {
    await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ keyPrefix: 'ratelimit:mandate-setup:wallet' }),
      WALLET_ID
    );
  });

  it('C5 — a malformed body does not consume a token', async () => {
    const res = await inject(
      { walletId: 'not-a-uuid', actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('C6 — saved_card without clientRequestId does not consume a token (guard sits below that check)', async () => {
    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID, paymentMethodSource: 'saved_card' },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});
