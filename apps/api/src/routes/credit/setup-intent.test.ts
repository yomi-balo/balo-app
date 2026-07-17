import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockCreateSetupIntent = vi.fn();
vi.mock('../../services/stripe/index.js', () => ({
  createSetupIntent: (...args: unknown[]) => mockCreateSetupIntent(...args),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { setupIntentRoute } from './setup-intent.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';
const WALLET_ID = '550e8400-e29b-41d4-a716-446655440000';

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
    const res = await inject({ walletId: 'not-a-uuid' }, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('creates the SetupIntent and returns the client secret + ids', async () => {
    const res = await inject({ walletId: WALLET_ID }, { 'x-internal-api-key': TEST_SECRET });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_1',
      customerId: 'cus_1',
    });
    expect(mockCreateSetupIntent).toHaveBeenCalledWith(WALLET_ID);
  });
});
