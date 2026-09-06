import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockCreateSetupIntent, mockCheckRateLimit } = vi.hoisted(() => ({
  mockCreateSetupIntent: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('../../services/stripe/mandate.js', () => ({
  createSetupIntent: mockCreateSetupIntent,
}));

// Infra the app pulls in during buildApp — mocked so no real Redis / DB / Sentry.
vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({}),
  createRedisConnection: () => ({}),
}));

// BAL-527 — the route now calls `enforceMandateSetupRateLimit`, which calls `checkRateLimit`.
// `getRedis()` above returns `{}` with no `.multi()`, so without this mock every request would
// hit a `TypeError` inside `checkRateLimit` and 503. ⚠ SPREAD THE REAL MODULE so
// `RATE_LIMIT_DEADLINE_MS` (a real constant `withDeadline` reads) survives the mock.
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('../../lib/queue.js', () => ({
  getQueue: vi.fn(() => ({ add: vi.fn() })),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@balo/db', () => ({}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';

// ── Tests ──────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';
const WALLET_ID = '550e8400-e29b-41d4-a716-446655440000';
const ACTOR_USER_ID = '550e8400-e29b-41d4-a716-446655440099';

describe('POST /stripe/setup-intent', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSetupIntent.mockResolvedValue({
      clientSecret: 'seti_123_secret_abc',
      setupIntentId: 'seti_123',
      customerId: 'cus_123',
    });
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 3600 });
  });

  function inject(body?: Record<string, unknown>, headers?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/stripe/setup-intent',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body && { payload: body }),
    });
  }

  it('returns 401 when the x-internal-api-key header is missing', async () => {
    const res = await inject({ walletId: WALLET_ID });
    expect(res.statusCode).toBe(401);
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('returns 401 when the key is wrong', async () => {
    const res = await inject({ walletId: WALLET_ID }, { 'x-internal-api-key': 'wrong-key' });
    expect(res.statusCode).toBe(401);
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('returns 400 (and does not call the service) when walletId is not a uuid', async () => {
    const res = await inject(
      { walletId: 'not-a-uuid', actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('returns 400 when walletId is missing', async () => {
    const res = await inject({}, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(400);
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

  it('returns 200 with only clientSecret + setupIntentId (never the customerId)', async () => {
    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ clientSecret: 'seti_123_secret_abc', setupIntentId: 'seti_123' });
    expect(mockCreateSetupIntent).toHaveBeenCalledWith(WALLET_ID, ACTOR_USER_ID);
  });

  // ── BAL-527 — the per-wallet rate limit (this is the redeem path the original ticket never
  // named — O3 — so it shares the guard rather than going unmetered) ────────────────────────

  it('S1 — over the limit: 429, and createSetupIntent is never called', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 31, ttlSeconds: 600 });

    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'rate_limited', cooldownSeconds: 600 });
    expect(res.headers['retry-after']).toBe('600');
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('S2 — 503 on a Redis failure, fails CLOSED', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('redis unreachable'));

    const res = await inject(
      { walletId: WALLET_ID, actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('S3 — the bucket is keyed on walletId', async () => {
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

  it('S4 — a malformed body burns no token', async () => {
    const res = await inject(
      { walletId: 'not-a-uuid', actorUserId: ACTOR_USER_ID },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});
