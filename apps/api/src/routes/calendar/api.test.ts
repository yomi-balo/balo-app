import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockListConnectionsByExpertProfileId,
  mockFindSubCalendarsByConnectionId,
  mockFindConnectionByExpertAndProvider,
  mockFindSubCalendarByCalendarId,
  mockUpdateConflictCheck,
  mockUpdateTargetCalendarIdForProvider,
  mockSoftDeleteConnection,
  mockDisconnectProvider,
  mockEnqueueAvailabilityCacheRebuild,
} = vi.hoisted(() => ({
  mockListConnectionsByExpertProfileId: vi.fn(),
  mockFindSubCalendarsByConnectionId: vi.fn(),
  mockFindConnectionByExpertAndProvider: vi.fn(),
  mockFindSubCalendarByCalendarId: vi.fn(),
  mockUpdateConflictCheck: vi.fn(),
  mockUpdateTargetCalendarIdForProvider: vi.fn(),
  mockSoftDeleteConnection: vi.fn(),
  mockDisconnectProvider: vi.fn(),
  mockEnqueueAvailabilityCacheRebuild: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  calendarRepository: {
    listConnectionsByExpertProfileId: mockListConnectionsByExpertProfileId,
    findSubCalendarsByConnectionId: mockFindSubCalendarsByConnectionId,
    findConnectionByExpertAndProvider: mockFindConnectionByExpertAndProvider,
    findSubCalendarByCalendarId: mockFindSubCalendarByCalendarId,
    updateConflictCheck: mockUpdateConflictCheck,
    updateTargetCalendarIdForProvider: mockUpdateTargetCalendarIdForProvider,
    softDeleteConnection: mockSoftDeleteConnection,
  },
}));

vi.mock('../../services/calendar/apiroc-connection.js', () => ({
  disconnectProvider: mockDisconnectProvider,
}));

vi.mock('../../jobs/availability-cache.js', () => ({
  enqueueAvailabilityCacheRebuild: mockEnqueueAvailabilityCacheRebuild,
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
  CALENDAR_SERVER_EVENTS: Object.freeze({
    DISCONNECTED: 'calendar_disconnected',
  }),
  toCalendarEventProvider: (p: string) => (p === 'google' || p === 'microsoft' ? p : undefined),
}));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { trackServer } from '@balo/analytics/server';

// ── Constants ──────────────────────────────────────────────────

const TEST_SECRET = 'test-internal-secret';
const EXPERT_UUID = '550e8400-e29b-41d4-a716-446655440000';
const AUTH_HEADERS = {
  'content-type': 'application/json',
  'x-internal-api-key': TEST_SECRET,
};

function buildConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    expertProfileId: EXPERT_UUID,
    provider: 'google',
    providerEmail: 'dana@example.com',
    credentialStatus: 'ACTIVE',
    lastSyncedAt: null,
    targetCalendarId: 'cal-primary',
    ...overrides,
  };
}

function buildSubCalendar(overrides: Record<string, unknown> = {}) {
  return {
    calendarId: 'cal-primary',
    name: 'Primary',
    provider: 'google',
    isPrimary: true,
    conflictCheck: true,
    color: null,
    ...overrides,
  };
}

describe('calendar API routes (BAL-396)', () => {
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

  // ── GET /api/calendar/connection ────────────────────────────────

  describe('GET /api/calendar/connection', () => {
    it('returns 401 without auth header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/calendar/connection?expertProfileId=${EXPERT_UUID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for an invalid expertProfileId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/calendar/connection?expertProfileId=not-a-uuid',
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns { connections: [] } when nothing is connected — no legacy `connection` key', async () => {
      mockListConnectionsByExpertProfileId.mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/calendar/connection?expertProfileId=${EXPERT_UUID}`,
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({ connections: [] });
      expect(body).not.toHaveProperty('connection');
    });

    it('returns the per-provider summaries with the real credentialStatus vocabulary', async () => {
      mockListConnectionsByExpertProfileId.mockResolvedValue([
        buildConnection(),
        buildConnection({ id: 'conn-2', provider: 'microsoft', targetCalendarId: 'cal-ms' }),
      ]);
      mockFindSubCalendarsByConnectionId.mockResolvedValue([buildSubCalendar()]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/calendar/connection?expertProfileId=${EXPERT_UUID}`,
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.connections).toHaveLength(2);
      expect(body.connections[0]).toEqual({
        // BAL-396 fix round 2, Finding 6 — the connection-level provider, always present
        // regardless of subCalendars (which can be empty while SYNC_PENDING).
        provider: 'google',
        credentialStatus: 'ACTIVE',
        providerEmail: 'dana@example.com',
        lastSyncedAt: null,
        targetCalendarId: 'cal-primary',
        subCalendars: [
          {
            id: 'cal-primary',
            name: 'Primary',
            provider: 'google',
            primary: true,
            conflictChecking: true,
            color: undefined,
          },
        ],
      });
      expect(body.connections[1].provider).toBe('microsoft');
    });

    // BAL-397 — this is the regression the deleted `toLegacyStatus` adapter used to cause:
    // EXPIRED and REVOKED must arrive DISTINCT on the wire (they share one UX client-side, but
    // stay observable in logs/analytics), and every status round-trips verbatim.
    it.each([
      ['ACTIVE', 'ACTIVE'],
      ['SYNC_PENDING', 'SYNC_PENDING'],
      ['EXPIRED', 'EXPIRED'],
      ['REVOKED', 'REVOKED'],
    ])('carries credentialStatus %s through unmodified', async (dbStatus, wireStatus) => {
      mockListConnectionsByExpertProfileId.mockResolvedValue([
        buildConnection({ credentialStatus: dbStatus }),
      ]);
      mockFindSubCalendarsByConnectionId.mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/calendar/connection?expertProfileId=${EXPERT_UUID}`,
        headers: AUTH_HEADERS,
      });

      expect(res.json().connections[0].credentialStatus).toBe(wireStatus);
    });

    // BAL-396 fix round, Finding 7 — the `office365` translation was Cronofy-only and dead:
    // migration 0069 deletes every Cronofy-era row (the only source of that value), and Apiroc
    // always writes lowercase `google` / `microsoft` directly. What remains defensible is that
    // `provider` is a bare `text` column with no CHECK, so `mapProvider` still narrows rather
    // than asserts — this pins the fallback for a value outside the known union.
    it('falls back to google for a provider value outside the known union (no CHECK constrains the column)', async () => {
      mockListConnectionsByExpertProfileId.mockResolvedValue([
        buildConnection({ provider: 'something-unexpected' }),
      ]);
      mockFindSubCalendarsByConnectionId.mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/calendar/connection?expertProfileId=${EXPERT_UUID}`,
        headers: AUTH_HEADERS,
      });

      expect(res.json().connections[0].provider).toBe('google');
    });

    it('returns 500 when the repository throws', async () => {
      mockListConnectionsByExpertProfileId.mockRejectedValue(new Error('db down'));

      const res = await app.inject({
        method: 'GET',
        url: `/api/calendar/connection?expertProfileId=${EXPERT_UUID}`,
        headers: AUTH_HEADERS,
      });

      expect(res.statusCode).toBe(500);
    });
  });

  // ── POST /api/calendar/disconnect ───────────────────────────────

  describe('POST /api/calendar/disconnect', () => {
    it('returns 400 for an invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/disconnect',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: 'not-a-uuid' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('with provider: disconnects that provider only, rebuilds availability, tracks with provider', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/disconnect',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID, provider: 'google' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockDisconnectProvider).toHaveBeenCalledWith(EXPERT_UUID, 'google');
      expect(mockDisconnectProvider).toHaveBeenCalledTimes(1);
      expect(mockSoftDeleteConnection).not.toHaveBeenCalled();
      expect(mockEnqueueAvailabilityCacheRebuild).toHaveBeenCalledWith(
        EXPERT_UUID,
        expect.anything()
      );
      expect(trackServer).toHaveBeenCalledWith('calendar_disconnected', {
        provider: 'google',
        distinct_id: EXPERT_UUID,
      });
    });

    it('without provider: loops over every live connection, then soft-deletes as a backstop', async () => {
      mockListConnectionsByExpertProfileId.mockResolvedValue([
        buildConnection({ provider: 'google' }),
        buildConnection({ id: 'conn-2', provider: 'microsoft' }),
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/disconnect',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID },
      });

      expect(res.statusCode).toBe(200);
      expect(mockDisconnectProvider).toHaveBeenNthCalledWith(1, EXPERT_UUID, 'google');
      expect(mockDisconnectProvider).toHaveBeenNthCalledWith(2, EXPERT_UUID, 'microsoft');
      expect(mockSoftDeleteConnection).toHaveBeenCalledWith(EXPERT_UUID);
      expect(trackServer).toHaveBeenCalledWith('calendar_disconnected', {
        distinct_id: EXPERT_UUID,
      });
    });

    it('returns 500 when disconnectProvider throws', async () => {
      mockDisconnectProvider.mockRejectedValue(new Error('vendor down'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/disconnect',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID, provider: 'google' },
      });

      expect(res.statusCode).toBe(500);
    });
  });

  // ── POST /api/calendar/toggle-conflict-check ────────────────────

  describe('POST /api/calendar/toggle-conflict-check', () => {
    it('returns 400 for an invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/toggle-conflict-check',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when no connection owns the calendar id', async () => {
      mockListConnectionsByExpertProfileId.mockResolvedValue([buildConnection()]);
      mockFindSubCalendarByCalendarId.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/toggle-conflict-check',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID, calendarId: 'cal-unknown', conflictCheck: false },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when disabling conflict-check on the primary calendar', async () => {
      mockListConnectionsByExpertProfileId.mockResolvedValue([buildConnection()]);
      mockFindSubCalendarByCalendarId.mockResolvedValue(buildSubCalendar({ isPrimary: true }));

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/toggle-conflict-check',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID, calendarId: 'cal-primary', conflictCheck: false },
      });

      expect(res.statusCode).toBe(400);
      expect(mockUpdateConflictCheck).not.toHaveBeenCalled();
    });

    it('resolves the owning connection by calendar id (across a second provider) and toggles', async () => {
      mockListConnectionsByExpertProfileId.mockResolvedValue([
        buildConnection({ id: 'conn-1', provider: 'google' }),
        buildConnection({ id: 'conn-2', provider: 'microsoft' }),
      ]);
      mockFindSubCalendarByCalendarId
        .mockResolvedValueOnce(undefined) // not on conn-1
        .mockResolvedValueOnce(buildSubCalendar({ isPrimary: false, calendarId: 'cal-ms' })); // on conn-2

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/toggle-conflict-check',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID, calendarId: 'cal-ms', conflictCheck: true },
      });

      expect(res.statusCode).toBe(200);
      expect(mockUpdateConflictCheck).toHaveBeenCalledWith('conn-2', 'cal-ms', true);
      // BAL-396 fix round, Finding 5 — `listBusyReadTargets` filters on `conflict_check`, so
      // toggling it changes what the booking gate reads; without a rebuild the advertise cache
      // goes stale against it (409s on advertised slots when toggled ON, under-advertised when
      // toggled OFF). Matches the disconnect handler's rebuild call.
      expect(mockEnqueueAvailabilityCacheRebuild).toHaveBeenCalledWith(
        EXPERT_UUID,
        expect.anything()
      );
    });

    it('rebuilds availability even when disabling conflict-check (the under-advertised direction)', async () => {
      mockListConnectionsByExpertProfileId.mockResolvedValue([buildConnection()]);
      mockFindSubCalendarByCalendarId.mockResolvedValue(
        buildSubCalendar({ isPrimary: false, calendarId: 'cal-secondary' })
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/toggle-conflict-check',
        headers: AUTH_HEADERS,
        payload: {
          expertProfileId: EXPERT_UUID,
          calendarId: 'cal-secondary',
          conflictCheck: false,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockEnqueueAvailabilityCacheRebuild).toHaveBeenCalledWith(
        EXPERT_UUID,
        expect.anything()
      );
    });
  });

  // ── POST /api/calendar/set-target-calendar ──────────────────────

  describe('POST /api/calendar/set-target-calendar', () => {
    it('returns 400 for an invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/set-target-calendar',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID },
      });
      expect(res.statusCode).toBe(400);
    });

    it('with provider: 404 when no connection exists for it', async () => {
      mockFindConnectionByExpertAndProvider.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/set-target-calendar',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID, targetCalendarId: 'cal-x', provider: 'google' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('with provider: 404 when the calendar is not one of that connection’s sub-calendars', async () => {
      mockFindConnectionByExpertAndProvider.mockResolvedValue(buildConnection());
      mockFindSubCalendarByCalendarId.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/set-target-calendar',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID, targetCalendarId: 'cal-x', provider: 'google' },
      });

      expect(res.statusCode).toBe(404);
      expect(mockUpdateTargetCalendarIdForProvider).not.toHaveBeenCalled();
    });

    it('with provider: writes per-provider on success', async () => {
      mockFindConnectionByExpertAndProvider.mockResolvedValue(buildConnection());
      mockFindSubCalendarByCalendarId.mockResolvedValue(buildSubCalendar());

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/set-target-calendar',
        headers: AUTH_HEADERS,
        payload: {
          expertProfileId: EXPERT_UUID,
          targetCalendarId: 'cal-primary',
          provider: 'google',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockUpdateTargetCalendarIdForProvider).toHaveBeenCalledWith(
        EXPERT_UUID,
        'google',
        'cal-primary'
      );
    });

    it('without provider: resolves the owning connection from the calendar id', async () => {
      mockListConnectionsByExpertProfileId.mockResolvedValue([
        buildConnection({ id: 'conn-1', provider: 'google' }),
        buildConnection({ id: 'conn-2', provider: 'microsoft' }),
      ]);
      mockFindSubCalendarByCalendarId
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(buildSubCalendar({ calendarId: 'cal-ms' }));

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/set-target-calendar',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID, targetCalendarId: 'cal-ms' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockUpdateTargetCalendarIdForProvider).toHaveBeenCalledWith(
        EXPERT_UUID,
        'microsoft',
        'cal-ms'
      );
    });

    it('without provider: 404 when no connection owns the calendar id', async () => {
      mockListConnectionsByExpertProfileId.mockResolvedValue([buildConnection()]);
      mockFindSubCalendarByCalendarId.mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/set-target-calendar',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID, targetCalendarId: 'cal-unknown' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── Deleted endpoints ────────────────────────────────────────────

  describe('deleted endpoints (BAL-396)', () => {
    it('GET /api/calendar/relink no longer exists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/calendar/relink?expertProfileId=${EXPERT_UUID}`,
        headers: AUTH_HEADERS,
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/calendar/refresh-calendars no longer exists', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/calendar/refresh-calendars',
        headers: AUTH_HEADERS,
        payload: { expertProfileId: EXPERT_UUID },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
