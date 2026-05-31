import { describe, it, expect, afterEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const { mockRegenerate, mockRefresh, mockReset } = vi.hoisted(() => ({
  mockRegenerate: vi.fn(),
  mockRefresh: vi.fn(),
  mockReset: vi.fn(),
}));

vi.mock('../../services/seed/seed-service.js', () => ({
  regenerateExperts: mockRegenerate,
  refreshAvailability: mockRefresh,
  fullReset: mockReset,
}));

vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({}),
  createRedisConnection: () => ({}),
}));

vi.mock('../../lib/queue.js', () => ({
  getQueue: vi.fn(() => ({ add: vi.fn() })),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@balo/db', () => ({ calendarRepository: {} }));

vi.mock('@sentry/node', () => ({ init: vi.fn(), captureException: vi.fn() }));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';

const TEST_SECRET = 'test-internal-secret';
const AUTH_HEADER = { 'x-internal-api-key': TEST_SECRET };

describe('dev seed routes — prod gate', () => {
  let app: FastifyInstance;
  const originalEnv = process.env.NODE_ENV;

  afterEach(async () => {
    if (app) await app.close();
    process.env.NODE_ENV = originalEnv;
    delete process.env.INTERNAL_API_SECRET;
    vi.clearAllMocks();
  });

  it('does NOT register /dev/seed/* when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    app = await buildApp({ logger: false });

    const response = await app.inject({
      method: 'POST',
      url: '/dev/seed/experts',
      headers: AUTH_HEADER,
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(mockRegenerate).not.toHaveBeenCalled();
  });

  it('registers /dev/seed/* in non-production', async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    mockRegenerate.mockResolvedValue({
      ok: true,
      expertsGenerated: 60,
      skillsGenerated: 300,
      languagesGenerated: 90,
      industriesGenerated: 120,
      seedUsedRng: 20239,
      baselineAt: '2026-05-31T00:00:00.000Z',
    });
    app = await buildApp({ logger: false });

    const response = await app.inject({
      method: 'POST',
      url: '/dev/seed/experts',
      headers: AUTH_HEADER,
      payload: { count: 60 },
    });

    expect(response.statusCode).toBe(200);
    expect(mockRegenerate).toHaveBeenCalledWith({ count: 60, seed: 20239 });
  });

  it('returns 401 without the internal API key', async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    app = await buildApp({ logger: false });

    const response = await app.inject({
      method: 'POST',
      url: '/dev/seed/experts',
      payload: { count: 60 },
    });

    expect(response.statusCode).toBe(401);
    expect(mockRegenerate).not.toHaveBeenCalled();
  });

  it('returns 400 on an out-of-range count', async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    app = await buildApp({ logger: false });

    const response = await app.inject({
      method: 'POST',
      url: '/dev/seed/experts',
      headers: AUTH_HEADER,
      payload: { count: 99999 },
    });

    expect(response.statusCode).toBe(400);
    expect(mockRegenerate).not.toHaveBeenCalled();
  });
});
