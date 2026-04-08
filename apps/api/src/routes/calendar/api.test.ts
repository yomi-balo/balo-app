import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockFindConnectionWithSubCalendars,
  mockFindConnectionByExpertProfileId,
  mockFindSubCalendarByCalendarId,
  mockUpdateConflictCheck,
  mockUpdateTargetCalendarId,
  mockDisconnectCalendar,
  mockListAndStoreCalendars,
  mockWithCronofyRetry,
  mockGetValidAccessToken,
  mockGetCronofyUserClient,
} = vi.hoisted(() => ({
  mockFindConnectionWithSubCalendars: vi.fn(),
  mockFindConnectionByExpertProfileId: vi.fn(),
  mockFindSubCalendarByCalendarId: vi.fn(),
  mockUpdateConflictCheck: vi.fn(),
  mockUpdateTargetCalendarId: vi.fn(),
  mockDisconnectCalendar: vi.fn(),
  mockListAndStoreCalendars: vi.fn(),
  mockWithCronofyRetry: vi.fn(),
  mockGetValidAccessToken: vi.fn(),
  mockGetCronofyUserClient: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  calendarRepository: {
    findConnectionWithSubCalendars: mockFindConnectionWithSubCalendars,
    findConnectionByExpertProfileId: mockFindConnectionByExpertProfileId,
    findSubCalendarByCalendarId: mockFindSubCalendarByCalendarId,
    updateConflictCheck: mockUpdateConflictCheck,
    updateTargetCalendarId: mockUpdateTargetCalendarId,
  },
}));

vi.mock('../../services/cronofy/oauth.js', () => ({
  disconnectCalendar: mockDisconnectCalendar,
  listAndStoreCalendars: mockListAndStoreCalendars,
}));

vi.mock('../../services/cronofy/retry.js', () => ({
  withCronofyRetry: mockWithCronofyRetry,
}));

vi.mock('../../services/cronofy/token-manager.js', () => ({
  getValidAccessToken: mockGetValidAccessToken,
}));

vi.mock('../../lib/cronofy.js', () => ({
  getCronofyUserClient: mockGetCronofyUserClient,
  getCronofyAppClient: vi.fn(),
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

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: vi.fn(),
  CALENDAR_SERVER_EVENTS: {
    DISCONNECTED: 'calendar_disconnected',
    RELINK_URL_GENERATED: 'calendar_relink_url_generated',
  },
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

describe('calendar API routes', () => {
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

  // ── GET /api/calendar/connection ──────────────────────────────

  describe('GET /api/calendar/connection', () => {
    it('returns 401 without auth header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/connection',
        query: { expertProfileId: EXPERT_UUID },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for invalid expertProfileId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/connection',
        query: { expertProfileId: 'not-a-uuid' },
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns connection with sub-calendars mapped', async () => {
      mockFindConnectionWithSubCalendars.mockResolvedValue({
        status: 'connected',
        providerEmail: 'user@gmail.com',
        lastSyncedAt: new Date('2024-01-01T00:00:00Z'),
        targetCalendarId: 'cal-1',
        subCalendars: [
          {
            calendarId: 'cal-1',
            name: 'Primary',
            provider: 'google',
            isPrimary: true,
            conflictCheck: true,
            color: '#4285F4',
          },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/connection',
        query: { expertProfileId: EXPERT_UUID },
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.connection.status).toBe('connected');
      expect(body.connection.subCalendars[0].id).toBe('cal-1');
      expect(body.connection.subCalendars[0].primary).toBe(true);
      expect(body.connection.subCalendars[0].conflictChecking).toBe(true);
    });

    it('maps office365 provider to microsoft', async () => {
      mockFindConnectionWithSubCalendars.mockResolvedValue({
        status: 'connected',
        providerEmail: 'user@outlook.com',
        lastSyncedAt: null,
        targetCalendarId: null,
        subCalendars: [
          {
            calendarId: 'cal-o365',
            name: 'Outlook',
            provider: 'office365',
            isPrimary: true,
            conflictCheck: true,
            color: null,
          },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/connection',
        query: { expertProfileId: EXPERT_UUID },
        headers: AUTH_HEADERS,
      });

      expect(res.json().connection.subCalendars[0].provider).toBe('microsoft');
    });

    it('returns null when no connection', async () => {
      mockFindConnectionWithSubCalendars.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/connection',
        query: { expertProfileId: EXPERT_UUID },
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().connection).toBeNull();
    });

    it('returns 500 when repository throws', async () => {
      mockFindConnectionWithSubCalendars.mockRejectedValue(new Error('DB error'));

      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/connection',
        query: { expertProfileId: EXPERT_UUID },
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(500);
    });
  });

  // ── POST /api/calendar/disconnect ─────────────────────────────

  describe('POST /api/calendar/disconnect', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/disconnect',
        headers: { 'content-type': 'application/json' },
        payload: { expertProfileId: EXPERT_UUID },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/disconnect',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: 'bad' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('disconnects and returns success', async () => {
      mockDisconnectCalendar.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/disconnect',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(mockDisconnectCalendar).toHaveBeenCalledWith(EXPERT_UUID);
    });

    it('returns 500 when disconnect throws', async () => {
      mockDisconnectCalendar.mockRejectedValue(new Error('Revoke failed'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/disconnect',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID },
      });

      expect(res.statusCode).toBe(500);
    });
  });

  // ── POST /api/calendar/toggle-conflict-check ──────────────────

  describe('POST /api/calendar/toggle-conflict-check', () => {
    it('returns 400 for invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/toggle-conflict-check',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: 'bad' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when no connection found', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/toggle-conflict-check',
        headers: AUTH_HEADERS,
        payload: {
          expertProfileId: EXPERT_UUID,
          calendarId: 'cal-1',
          conflictCheck: false,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when sub-calendar not found', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({ id: 'conn-1' });
      mockFindSubCalendarByCalendarId.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/toggle-conflict-check',
        headers: AUTH_HEADERS,
        payload: {
          expertProfileId: EXPERT_UUID,
          calendarId: 'cal-nonexistent',
          conflictCheck: true,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when disabling conflict check on primary calendar', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({ id: 'conn-1' });
      mockFindSubCalendarByCalendarId.mockResolvedValue({ isPrimary: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/toggle-conflict-check',
        headers: AUTH_HEADERS,
        payload: {
          expertProfileId: EXPERT_UUID,
          calendarId: 'cal-1',
          conflictCheck: false,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Cannot disable conflict checking on primary');
    });

    it('toggles conflict check on non-primary calendar', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({ id: 'conn-1' });
      mockFindSubCalendarByCalendarId.mockResolvedValue({ isPrimary: false });
      mockUpdateConflictCheck.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/toggle-conflict-check',
        headers: AUTH_HEADERS,
        payload: {
          expertProfileId: EXPERT_UUID,
          calendarId: 'cal-2',
          conflictCheck: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(mockUpdateConflictCheck).toHaveBeenCalledWith('conn-1', 'cal-2', true);
    });

    it('allows enabling conflict check on primary calendar', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({ id: 'conn-1' });
      mockFindSubCalendarByCalendarId.mockResolvedValue({ isPrimary: true });
      mockUpdateConflictCheck.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/toggle-conflict-check',
        headers: AUTH_HEADERS,
        payload: {
          expertProfileId: EXPERT_UUID,
          calendarId: 'cal-1',
          conflictCheck: true,
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 500 when repository throws', async () => {
      mockFindConnectionByExpertProfileId.mockRejectedValue(new Error('DB error'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/toggle-conflict-check',
        headers: AUTH_HEADERS,
        payload: {
          expertProfileId: EXPERT_UUID,
          calendarId: 'cal-1',
          conflictCheck: true,
        },
      });

      expect(res.statusCode).toBe(500);
    });
  });

  // ── POST /api/calendar/set-target-calendar ────────────────────

  describe('POST /api/calendar/set-target-calendar', () => {
    it('returns 400 for invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/set-target-calendar',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when no connection found', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/set-target-calendar',
        headers: AUTH_HEADERS,
        payload: {
          expertProfileId: EXPERT_UUID,
          targetCalendarId: 'cal-1',
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when target calendar not in sub-calendars', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({ id: 'conn-1' });
      mockFindSubCalendarByCalendarId.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/set-target-calendar',
        headers: AUTH_HEADERS,
        payload: {
          expertProfileId: EXPERT_UUID,
          targetCalendarId: 'cal-nonexistent',
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toContain('Calendar not found');
    });

    it('sets target calendar on success', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({ id: 'conn-1' });
      mockFindSubCalendarByCalendarId.mockResolvedValue({ calendarId: 'cal-1' });
      mockUpdateTargetCalendarId.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/set-target-calendar',
        headers: AUTH_HEADERS,
        payload: {
          expertProfileId: EXPERT_UUID,
          targetCalendarId: 'cal-1',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(mockUpdateTargetCalendarId).toHaveBeenCalledWith(EXPERT_UUID, 'cal-1');
    });

    it('returns 500 when repository throws', async () => {
      mockFindConnectionByExpertProfileId.mockRejectedValue(new Error('DB error'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/set-target-calendar',
        headers: AUTH_HEADERS,
        payload: {
          expertProfileId: EXPERT_UUID,
          targetCalendarId: 'cal-1',
        },
      });

      expect(res.statusCode).toBe(500);
    });
  });

  // ── POST /api/calendar/refresh-calendars ──────────────────────

  describe('POST /api/calendar/refresh-calendars', () => {
    it('returns 400 for invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/refresh-calendars',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: 'not-uuid' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('refreshes calendars via withCronofyRetry', async () => {
      mockWithCronofyRetry.mockImplementation(
        async (_id: string, fn: (token: string) => Promise<void>) => {
          await fn('mock-access-token');
        }
      );
      mockListAndStoreCalendars.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/refresh-calendars',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(mockWithCronofyRetry).toHaveBeenCalledWith(EXPERT_UUID, expect.any(Function));
    });

    it('returns 500 when refresh throws', async () => {
      mockWithCronofyRetry.mockRejectedValue(new Error('Token expired'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/refresh-calendars',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID },
      });

      expect(res.statusCode).toBe(500);
    });
  });

  // ── GET /api/calendar/relink ─────────────────────────────────

  describe('GET /api/calendar/relink', () => {
    it('returns 401 without auth header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/relink',
        query: { expertProfileId: EXPERT_UUID },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for invalid expertProfileId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/relink',
        query: { expertProfileId: 'not-a-uuid' },
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when no connection exists', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/relink',
        query: { expertProfileId: EXPERT_UUID },
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when connection is not in sync_pending state', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({
        id: 'conn-1',
        status: 'connected',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/relink',
        query: { expertProfileId: EXPERT_UUID },
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('not in sync_pending state');
    });

    it('returns relink URL on success', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({
        id: 'conn-1',
        status: 'sync_pending',
      });
      mockGetValidAccessToken.mockResolvedValue('mock-access-token');
      mockGetCronofyUserClient.mockReturnValue({
        userInfo: vi.fn().mockResolvedValue({
          profiles: [{ profile_relink_url: 'https://app.cronofy.com/relink/abc' }],
        }),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/relink',
        query: { expertProfileId: EXPERT_UUID },
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().relinkUrl).toBe('https://app.cronofy.com/relink/abc');
    });

    it('returns 400 when no relink URL in profile', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({
        id: 'conn-1',
        status: 'sync_pending',
      });
      mockGetValidAccessToken.mockResolvedValue('mock-access-token');
      mockGetCronofyUserClient.mockReturnValue({
        userInfo: vi.fn().mockResolvedValue({
          profiles: [{ profile_relink_url: null }],
        }),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/relink',
        query: { expertProfileId: EXPERT_UUID },
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('No relink URL available');
    });

    it('returns 500 when token retrieval fails', async () => {
      mockFindConnectionByExpertProfileId.mockResolvedValue({
        id: 'conn-1',
        status: 'sync_pending',
      });
      mockGetValidAccessToken.mockRejectedValue(new Error('Token error'));

      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/relink',
        query: { expertProfileId: EXPERT_UUID },
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(500);
    });
  });
});
