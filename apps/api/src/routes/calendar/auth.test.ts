import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const { mockGenerateCronofyAuthUrl, mockHandleOAuthCallback } = vi.hoisted(() => ({
  mockGenerateCronofyAuthUrl: vi.fn(),
  mockHandleOAuthCallback: vi.fn(),
}));

vi.mock('../../services/cronofy/oauth.js', () => ({
  generateCronofyAuthUrl: mockGenerateCronofyAuthUrl,
  handleOAuthCallback: mockHandleOAuthCallback,
}));

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

vi.mock('@balo/db', () => ({
  calendarRepository: {},
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: vi.fn(),
  CALENDAR_SERVER_EVENTS: {
    OAUTH_COMPLETED: 'calendar_oauth_completed',
    OAUTH_FAILED: 'calendar_oauth_failed',
  },
}));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';

// ── Tests ──────────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';
const EXPERT_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('calendar auth routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    process.env.WEB_APP_URL = 'https://app.balo.test';
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
    delete process.env.WEB_APP_URL;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function injectConnect(body?: Record<string, unknown>, headers?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: '/api/calendar/connect',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      ...(body && { payload: body }),
    });
  }

  // ── POST /api/calendar/connect ────────────────────────────────

  describe('POST /api/calendar/connect', () => {
    it('returns 401 when no auth header', async () => {
      const res = await injectConnect({ expertProfileId: EXPERT_UUID, provider: 'google' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for invalid body', async () => {
      const res = await injectConnect(
        { expertProfileId: 'not-a-uuid', provider: 'google' },
        { 'x-internal-api-key': TEST_SECRET }
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Invalid request body');
    });

    it('returns 400 for invalid provider', async () => {
      const res = await injectConnect(
        { expertProfileId: EXPERT_UUID, provider: 'invalid' },
        { 'x-internal-api-key': TEST_SECRET }
      );
      expect(res.statusCode).toBe(400);
    });

    it('returns authUrl on success', async () => {
      mockGenerateCronofyAuthUrl.mockReturnValue('https://app.cronofy.com/oauth/authorize?test=1');

      const res = await injectConnect(
        { expertProfileId: EXPERT_UUID, provider: 'google' },
        { 'x-internal-api-key': TEST_SECRET }
      );

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        authUrl: 'https://app.cronofy.com/oauth/authorize?test=1',
      });
      expect(mockGenerateCronofyAuthUrl).toHaveBeenCalledWith(EXPERT_UUID, 'google');
    });

    it('returns 500 when generateCronofyAuthUrl throws', async () => {
      mockGenerateCronofyAuthUrl.mockImplementation(() => {
        throw new Error('Missing config');
      });

      const res = await injectConnect(
        { expertProfileId: EXPERT_UUID, provider: 'microsoft' },
        { 'x-internal-api-key': TEST_SECRET }
      );

      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('Failed to initiate calendar connection');
    });
  });

  // ── GET /auth/cronofy/callback ────────────────────────────────

  describe('GET /auth/cronofy/callback', () => {
    it('redirects with success params on callback success', async () => {
      mockHandleOAuthCallback.mockResolvedValue({
        expertProfileId: EXPERT_UUID,
        provider: 'google',
        status: 'connected',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/auth/cronofy/callback',
        query: { code: 'auth-code', state: 'valid-state' },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_connected=true');
      expect(res.headers.location).toContain('calendar_status=connected');
      expect(res.headers.location).toContain('https://app.balo.test');
    });

    it('redirects with error on invalid callback params', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/cronofy/callback',
        query: {},
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=invalid_callback');
    });

    it('redirects with state_expired error code', async () => {
      mockHandleOAuthCallback.mockRejectedValue(new Error('State has expired'));

      const res = await app.inject({
        method: 'GET',
        url: '/auth/cronofy/callback',
        query: { code: 'code', state: 'expired-state' },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=state_expired');
    });

    it('redirects with invalid_state error code on signature error', async () => {
      mockHandleOAuthCallback.mockRejectedValue(new Error('Invalid state signature'));

      const res = await app.inject({
        method: 'GET',
        url: '/auth/cronofy/callback',
        query: { code: 'code', state: 'bad-state' },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=invalid_state');
    });

    it('redirects with callback_failed for generic errors', async () => {
      mockHandleOAuthCallback.mockRejectedValue(new Error('Token exchange failed'));

      const res = await app.inject({
        method: 'GET',
        url: '/auth/cronofy/callback',
        query: { code: 'code', state: 'state' },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendar_error=callback_failed');
    });
  });
});
