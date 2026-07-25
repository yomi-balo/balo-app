import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockFindProfileById,
  mockUpdateProfile,
  mockReplaceForExpert,
  mockDeleteAllForExpert,
  mockListRules,
  mockTransaction,
  mockGetQueue,
  mockQueueAdd,
} = vi.hoisted(() => ({
  mockFindProfileById: vi.fn(),
  mockUpdateProfile: vi.fn(),
  mockReplaceForExpert: vi.fn(),
  mockDeleteAllForExpert: vi.fn(),
  mockListRules: vi.fn(),
  mockTransaction: vi.fn(),
  mockGetQueue: vi.fn(),
  mockQueueAdd: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  expertsRepository: {
    findProfileById: mockFindProfileById,
    updateProfile: mockUpdateProfile,
  },
  availabilityRulesRepository: {
    replaceForExpert: mockReplaceForExpert,
    deleteAllForExpert: mockDeleteAllForExpert,
    listByExpertProfileId: mockListRules,
  },
  db: {
    transaction: (cb: (tx: unknown) => unknown) => mockTransaction(cb),
  },
}));

vi.mock('../../lib/queue.js', () => ({
  getQueue: (...args: unknown[]) => {
    mockGetQueue(...args);
    return { add: mockQueueAdd };
  },
}));

vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({}),
  createRedisConnection: () => ({}),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: vi.fn(),
  CALENDAR_SERVER_EVENTS: Object.freeze({
    WEBHOOK_RECEIVED: 'calendar_webhook_received',
    AVAILABILITY_CACHE_REBUILT: 'calendar_availability_cache_rebuilt',
    SYNC_PENDING_AUTO_RESOLVED: 'calendar_sync_pending_auto_resolved',
    DISCONNECTED: 'calendar_disconnected',
    RELINK_URL_GENERATED: 'calendar_relink_url_generated',
    OAUTH_COMPLETED: 'calendar_oauth_completed',
    OAUTH_FAILED: 'calendar_oauth_failed',
  }),
}));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';

// ── Constants ──────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';
const EXPERT_UUID = '550e8400-e29b-41d4-a716-446655440000';
const AUTH_HEADERS = {
  'content-type': 'application/json',
  'x-internal-api-key': TEST_SECRET,
};
// For bodyless requests (GET/DELETE): sending a JSON content-type with no body
// trips Fastify's body parser, so use the auth key alone.
const AUTH_ONLY = { 'x-internal-api-key': TEST_SECRET };

const PROFILE = {
  id: EXPERT_UUID,
  timezone: 'Australia/Melbourne',
  bookingBufferBeforeMinutes: 15,
  bookingBufferAfterMinutes: 30,
  bookingMinimumNoticeMinutes: 120,
  bookingWindowDays: 60,
};

/** Assert a rebuild job was enqueued with the coalescing jobId. */
const expectRebuildEnqueued = (): void => {
  expect(mockQueueAdd).toHaveBeenCalledWith(
    'rebuild-availability-cache',
    { expertProfileId: EXPERT_UUID },
    { jobId: `availability-${EXPERT_UUID}`, removeOnComplete: true, removeOnFail: false }
  );
};

const VALID_BODY = {
  timezone: 'Australia/Melbourne',
  bookingSettings: {
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 30,
    minimumNoticeMinutes: 120,
    windowDays: 60,
  },
  rules: [
    { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
    { dayOfWeek: 1, startTime: '13:00', endTime: '17:00' },
  ],
};

describe('experts schedule API routes', () => {
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
    // Default: transaction runs the callback with a fake tx handle.
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ __tx: true }));
  });

  // ── GET /api/experts/:expertProfileId/schedule ────────────────

  describe('GET /api/experts/:id/schedule', () => {
    it('returns 401 without auth header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for a non-uuid path param', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/experts/not-a-uuid/schedule',
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when the profile does not exist', async () => {
      mockFindProfileById.mockResolvedValue(undefined);
      mockListRules.mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns tz + booking settings + rules trimmed to HH:mm', async () => {
      mockFindProfileById.mockResolvedValue(PROFILE);
      mockListRules.mockResolvedValue([
        { dayOfWeek: 1, startTime: '09:00:00', endTime: '12:00:00' },
        { dayOfWeek: 1, startTime: '13:00:00', endTime: '17:00:00' },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({
        timezone: 'Australia/Melbourne',
        bookingSettings: {
          bufferBeforeMinutes: 15,
          bufferAfterMinutes: 30,
          minimumNoticeMinutes: 120,
          windowDays: 60,
        },
        rules: [
          { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
          { dayOfWeek: 1, startTime: '13:00', endTime: '17:00' },
        ],
      });
    });

    it('returns empty rules and default settings when unset', async () => {
      mockFindProfileById.mockResolvedValue({
        id: EXPERT_UUID,
        timezone: 'UTC',
        bookingBufferBeforeMinutes: 0,
        bookingBufferAfterMinutes: 0,
        bookingMinimumNoticeMinutes: 0,
        bookingWindowDays: 60,
      });
      mockListRules.mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.timezone).toBe('UTC');
      expect(body.rules).toEqual([]);
      expect(body.bookingSettings).toEqual({
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 0,
        windowDays: 60,
      });
    });
  });

  // ── POST /api/experts/:expertProfileId/schedule ───────────────

  describe('POST /api/experts/:id/schedule', () => {
    it('returns 401 without auth header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
        payload: VALID_BODY,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for an invalid timezone', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
        headers: AUTH_HEADERS,
        payload: { ...VALID_BODY, timezone: 'Not/ARealZone' },
      });
      expect(res.statusCode).toBe(400);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-15-minute time', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
        headers: AUTH_HEADERS,
        payload: {
          ...VALID_BODY,
          rules: [{ dayOfWeek: 1, startTime: '09:07', endTime: '12:00' }],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when startTime is not before endTime', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
        headers: AUTH_HEADERS,
        payload: {
          ...VALID_BODY,
          rules: [{ dayOfWeek: 1, startTime: '17:00', endTime: '09:00' }],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when the profile does not exist', async () => {
      mockFindProfileById.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
        headers: AUTH_HEADERS,
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(404);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('runs the cascade in a transaction then enqueues, returning the saved state', async () => {
      mockFindProfileById.mockResolvedValue(PROFILE);

      const res = await app.inject({
        method: 'POST',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
        headers: AUTH_HEADERS,
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        timezone: VALID_BODY.timezone,
        bookingSettings: VALID_BODY.bookingSettings,
        rules: VALID_BODY.rules,
      });

      // updateProfile maps resolver-vocabulary keys → DB columns, inside the tx.
      expect(mockUpdateProfile).toHaveBeenCalledWith(
        EXPERT_UUID,
        {
          timezone: 'Australia/Melbourne',
          bookingBufferBeforeMinutes: 15,
          bookingBufferAfterMinutes: 30,
          bookingMinimumNoticeMinutes: 120,
          bookingWindowDays: 60,
        },
        { __tx: true }
      );
      expect(mockReplaceForExpert).toHaveBeenCalledWith(EXPERT_UUID, VALID_BODY.rules, {
        __tx: true,
      });

      // Enqueue AFTER the tx, with the coalescing jobId.
      expectRebuildEnqueued();
    });

    it('returns 500 when the transaction fails', async () => {
      mockFindProfileById.mockResolvedValue(PROFILE);
      mockTransaction.mockRejectedValueOnce(new Error('db down'));

      const res = await app.inject({
        method: 'POST',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
        headers: AUTH_HEADERS,
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(500);
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  // ── DELETE /api/experts/:expertProfileId/schedule ─────────────

  describe('DELETE /api/experts/:id/schedule', () => {
    it('returns 401 without auth header', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when the profile does not exist', async () => {
      mockFindProfileById.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
        headers: AUTH_ONLY,
      });

      expect(res.statusCode).toBe(404);
      expect(mockDeleteAllForExpert).not.toHaveBeenCalled();
    });

    it('soft-deletes all rules then enqueues a rebuild', async () => {
      mockFindProfileById.mockResolvedValue(PROFILE);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/experts/${EXPERT_UUID}/schedule`,
        headers: AUTH_ONLY,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(mockDeleteAllForExpert).toHaveBeenCalledWith(EXPERT_UUID);
      expectRebuildEnqueued();
    });
  });

  // ── PATCH /api/experts/:expertProfileId/timezone ──────────────

  describe('PATCH /api/experts/:id/timezone', () => {
    it('returns 401 without auth header', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/experts/${EXPERT_UUID}/timezone`,
        payload: { timezone: 'UTC' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for an invalid timezone', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/experts/${EXPERT_UUID}/timezone`,
        headers: AUTH_HEADERS,
        payload: { timezone: 'Not/AZone' },
      });
      expect(res.statusCode).toBe(400);
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });

    it('returns 404 when the profile does not exist', async () => {
      mockFindProfileById.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/experts/${EXPERT_UUID}/timezone`,
        headers: AUTH_HEADERS,
        payload: { timezone: 'UTC' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('updates the timezone then enqueues a rebuild', async () => {
      mockFindProfileById.mockResolvedValue(PROFILE);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/experts/${EXPERT_UUID}/timezone`,
        headers: AUTH_HEADERS,
        payload: { timezone: 'America/New_York' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(mockUpdateProfile).toHaveBeenCalledWith(EXPERT_UUID, {
        timezone: 'America/New_York',
      });
      expectRebuildEnqueued();
    });
  });
});
