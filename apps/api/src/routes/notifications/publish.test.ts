import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockPublish } = vi.hoisted(() => {
  const mockPublish = vi.fn().mockResolvedValue(undefined);
  return { mockPublish };
});

vi.mock('../../notifications/index.js', () => ({
  notificationEvents: {
    publish: mockPublish,
  },
}));

vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({}),
  createRedisConnection: () => ({}),
}));

vi.mock('../../lib/queue.js', () => ({
  getQueue: vi.fn(() => ({ add: vi.fn() })),
}));

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => () => ({
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  })),
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';

// ── Tests ──────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';

describe('POST /notifications/publish', () => {
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
  });

  function inject(body?: Record<string, unknown>, headers?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      ...(body && { payload: body }),
    });
  }

  it('returns 401 when x-internal-api-key header is missing', async () => {
    const res = await inject({
      event: 'user.welcome',
      payload: {
        correlationId: '550e8400-e29b-41d4-a716-446655440000',
        userId: '550e8400-e29b-41d4-a716-446655440000',
        role: 'client',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Unauthorized');
  });

  it('returns 401 when key is wrong', async () => {
    const res = await inject(
      {
        event: 'user.welcome',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440000',
          role: 'client',
        },
      },
      { 'x-internal-api-key': 'wrong-key' }
    );
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when body fails Zod validation', async () => {
    const res = await inject(
      { event: 'unknown.event', payload: {} },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_payload');
  });

  it('returns 400 when user.welcome payload is missing role', async () => {
    const res = await inject(
      {
        event: 'user.welcome',
        payload: {
          correlationId: '550e8400-e29b-41d4-a716-446655440000',
          userId: '550e8400-e29b-41d4-a716-446655440000',
        },
      },
      { 'x-internal-api-key': TEST_SECRET }
    );
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 and publishes user.welcome event', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440000',
      role: 'client',
    };

    const res = await inject(
      { event: 'user.welcome', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(mockPublish).toHaveBeenCalledWith('user.welcome', payload);
  });

  it('returns 200 and publishes expert.application_submitted event', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      applicationId: '550e8400-e29b-41d4-a716-446655440000',
    };

    const res = await inject(
      { event: 'expert.application_submitted', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(mockPublish).toHaveBeenCalledWith('expert.application_submitted', payload);
  });

  it('returns 200 and publishes expert.approved event', async () => {
    const payload = {
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      expertProfileId: '550e8400-e29b-41d4-a716-446655440000',
    };

    const res = await inject(
      { event: 'expert.approved', payload },
      { 'x-internal-api-key': TEST_SECRET }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(mockPublish).toHaveBeenCalledWith('expert.approved', payload);
  });
});
