import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockCreateSetupIntent } = vi.hoisted(() => ({
  mockCreateSetupIntent: vi.fn(),
}));

vi.mock('../../services/stripe/mandate.js', () => ({
  createSetupIntent: mockCreateSetupIntent,
}));

// Infra the app pulls in during buildApp — mocked so no real Redis / DB / Sentry.
vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({}),
  createRedisConnection: () => ({}),
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
    const res = await inject({ walletId: 'not-a-uuid' }, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('returns 400 when walletId is missing', async () => {
    const res = await inject({}, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(400);
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('returns 200 with only clientSecret + setupIntentId (never the customerId)', async () => {
    const res = await inject({ walletId: WALLET_ID }, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ clientSecret: 'seti_123_secret_abc', setupIntentId: 'seti_123' });
    expect(mockCreateSetupIntent).toHaveBeenCalledWith(WALLET_ID);
  });
});
