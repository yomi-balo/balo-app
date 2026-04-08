import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const {
  mockFindConnectionByChannelId,
  mockUpdateLastSyncedAt,
  mockUpdateConnectionStatus,
  mockClearAvailabilityCache,
  mockGetValidAccessToken,
  mockListAndStoreCalendars,
  mockRegisterPushChannel,
  mockGetCronofyUserClient,
  mockGetQueue,
  mockNotificationPublish,
  mockTrackServer,
} = vi.hoisted(() => ({
  mockFindConnectionByChannelId: vi.fn(),
  mockUpdateLastSyncedAt: vi.fn(),
  mockUpdateConnectionStatus: vi.fn(),
  mockClearAvailabilityCache: vi.fn(),
  mockGetValidAccessToken: vi.fn(),
  mockListAndStoreCalendars: vi.fn(),
  mockRegisterPushChannel: vi.fn(),
  mockGetCronofyUserClient: vi.fn(),
  mockGetQueue: vi.fn(),
  mockNotificationPublish: vi.fn(),
  mockTrackServer: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  calendarRepository: {
    findConnectionByChannelId: mockFindConnectionByChannelId,
    updateLastSyncedAt: mockUpdateLastSyncedAt,
    updateConnectionStatus: mockUpdateConnectionStatus,
    clearAvailabilityCache: mockClearAvailabilityCache,
  },
}));

vi.mock('../../services/cronofy/token-manager.js', () => ({
  getValidAccessToken: mockGetValidAccessToken,
}));

vi.mock('../../services/cronofy/oauth.js', () => ({
  listAndStoreCalendars: mockListAndStoreCalendars,
  registerPushChannel: mockRegisterPushChannel,
}));

vi.mock('../../lib/cronofy.js', () => ({
  getCronofyUserClient: mockGetCronofyUserClient,
}));

const mockQueueAdd = vi.fn();
vi.mock('../../lib/queue.js', () => ({
  getQueue: (...args: unknown[]) => {
    mockGetQueue(...args);
    return { add: mockQueueAdd };
  },
}));

vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockNotificationPublish },
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
  trackServer: mockTrackServer,
  CALENDAR_SERVER_EVENTS: {
    WEBHOOK_RECEIVED: 'calendar_webhook_received',
    AVAILABILITY_CACHE_REBUILT: 'calendar_availability_cache_rebuilt',
    SYNC_PENDING_AUTO_RESOLVED: 'calendar_sync_pending_auto_resolved',
  },
}));

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';

// ── Constants ──────────────────────────────────────────────────

const EXPERT_ID = 'expert-profile-1';

describe('calendar webhook routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = 'test-secret';
    process.env.API_BASE_URL = 'https://api.balo.test';
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
    delete process.env.API_BASE_URL;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function injectWebhook(body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/webhooks/cronofy',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
  }

  /** The webhook handler fires `void reply.send()` then processes async.
   *  Fastify inject resolves when the response is sent, so we need to
   *  flush the microtask queue to let the background work complete. */
  async function flush(): Promise<void> {
    // Multiple ticks to ensure all chained awaits settle
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  // ── Always 200 ────────────────────────────────────────────────

  it('always responds 200 even for malformed body', async () => {
    const res = await injectWebhook({});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  // ── Verification ping ─────────────────────────────────────────

  it('handles verification notification type', async () => {
    const res = await injectWebhook({
      notification: { type: 'verification' },
      channel: {
        channel_id: 'ch-1',
        callback_url: 'https://api.balo.test/webhooks/cronofy',
      },
    });
    await flush();

    expect(res.statusCode).toBe(200);
    // Should not look up connection for verification
    expect(mockFindConnectionByChannelId).not.toHaveBeenCalled();
  });

  // ── Callback URL mismatch ────────────────────────────────────

  it('rejects webhook with mismatched callback_url', async () => {
    const res = await injectWebhook({
      notification: { type: 'change' },
      channel: {
        channel_id: 'ch-1',
        callback_url: 'https://evil.attacker.com/webhooks/cronofy',
      },
    });
    await flush();

    expect(res.statusCode).toBe(200); // Still 200 — we just ignore it
    expect(mockFindConnectionByChannelId).not.toHaveBeenCalled();
  });

  // ── Unknown channel ───────────────────────────────────────────

  it('logs warning for unknown channel ID', async () => {
    mockFindConnectionByChannelId.mockResolvedValue(undefined);

    const res = await injectWebhook({
      notification: { type: 'change' },
      channel: {
        channel_id: 'ch-unknown',
        callback_url: 'https://api.balo.test/webhooks/cronofy',
      },
    });
    await flush();

    expect(res.statusCode).toBe(200);
    expect(mockFindConnectionByChannelId).toHaveBeenCalledWith('ch-unknown');
    expect(mockUpdateLastSyncedAt).not.toHaveBeenCalled();
  });

  // ── Change notification ───────────────────────────────────────

  it('processes change notification — updates sync time and enqueues cache rebuild', async () => {
    mockFindConnectionByChannelId.mockResolvedValue({
      id: 'conn-1',
      expertProfileId: EXPERT_ID,
    });

    const res = await injectWebhook({
      notification: { type: 'change', changes_since: '2024-01-01T00:00:00Z' },
      channel: {
        channel_id: 'ch-1',
        callback_url: 'https://api.balo.test/webhooks/cronofy',
      },
    });
    await flush();

    expect(res.statusCode).toBe(200);
    expect(mockUpdateLastSyncedAt).toHaveBeenCalledWith('conn-1');
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'rebuild-availability-cache',
      { expertProfileId: EXPERT_ID },
      expect.objectContaining({
        jobId: `availability-${EXPERT_ID}`,
      })
    );
  });

  // ── Profile disconnected ──────────────────────────────────────

  it('processes profile_disconnected — sets auth_error, clears cache, publishes notification', async () => {
    mockFindConnectionByChannelId.mockResolvedValue({
      id: 'conn-1',
      expertProfileId: EXPERT_ID,
    });
    mockNotificationPublish.mockResolvedValue(undefined);

    const res = await injectWebhook({
      notification: { type: 'profile_disconnected' },
      channel: {
        channel_id: 'ch-1',
        callback_url: 'https://api.balo.test/webhooks/cronofy',
      },
    });
    await flush();

    expect(res.statusCode).toBe(200);
    expect(mockUpdateConnectionStatus).toHaveBeenCalledWith(EXPERT_ID, 'auth_error');
    expect(mockClearAvailabilityCache).toHaveBeenCalledWith(EXPERT_ID);
    expect(mockNotificationPublish).toHaveBeenCalledWith('calendar.auth_error', {
      correlationId: 'conn-1',
      expertProfileId: EXPERT_ID,
    });
  });

  // ── Profile connected ─────────────────────────────────────────

  it('processes profile_connected — transitions to connected when sync complete', async () => {
    mockFindConnectionByChannelId.mockResolvedValue({
      id: 'conn-1',
      expertProfileId: EXPERT_ID,
    });
    mockGetValidAccessToken.mockResolvedValue('access-token');
    mockGetCronofyUserClient.mockReturnValue({
      userInfo: vi.fn().mockResolvedValue({
        profiles: [{ profile_initial_sync_required: false }],
      }),
    });
    mockListAndStoreCalendars.mockResolvedValue(undefined);
    mockRegisterPushChannel.mockResolvedValue(undefined);

    const res = await injectWebhook({
      notification: { type: 'profile_connected' },
      channel: {
        channel_id: 'ch-1',
        callback_url: 'https://api.balo.test/webhooks/cronofy',
      },
    });
    await flush();

    expect(res.statusCode).toBe(200);
    expect(mockUpdateConnectionStatus).toHaveBeenCalledWith(EXPERT_ID, 'connected');
    expect(mockListAndStoreCalendars).toHaveBeenCalledWith(EXPERT_ID, 'access-token');
    expect(mockRegisterPushChannel).toHaveBeenCalledWith(EXPERT_ID, 'access-token');
    expect(mockQueueAdd).toHaveBeenCalled();
    expect(mockTrackServer).toHaveBeenCalledWith('calendar_sync_pending_auto_resolved', {
      distinct_id: EXPERT_ID,
    });
  });

  it('stays in sync_pending when profile_connected but sync still required', async () => {
    mockFindConnectionByChannelId.mockResolvedValue({
      id: 'conn-1',
      expertProfileId: EXPERT_ID,
    });
    mockGetValidAccessToken.mockResolvedValue('access-token');
    mockGetCronofyUserClient.mockReturnValue({
      userInfo: vi.fn().mockResolvedValue({
        profiles: [{ profile_initial_sync_required: true }],
      }),
    });

    const res = await injectWebhook({
      notification: { type: 'profile_connected' },
      channel: {
        channel_id: 'ch-1',
        callback_url: 'https://api.balo.test/webhooks/cronofy',
      },
    });
    await flush();

    expect(res.statusCode).toBe(200);
    expect(mockUpdateConnectionStatus).not.toHaveBeenCalled();
    expect(mockListAndStoreCalendars).not.toHaveBeenCalled();
  });

  it('handles errors during profile_connected processing gracefully', async () => {
    mockFindConnectionByChannelId.mockResolvedValue({
      id: 'conn-1',
      expertProfileId: EXPERT_ID,
    });
    mockGetValidAccessToken.mockRejectedValue(new Error('Token refresh failed'));

    const res = await injectWebhook({
      notification: { type: 'profile_connected' },
      channel: {
        channel_id: 'ch-1',
        callback_url: 'https://api.balo.test/webhooks/cronofy',
      },
    });
    await flush();

    // Should still return 200 — error is logged, not re-thrown
    expect(res.statusCode).toBe(200);
  });

  // ── Unhandled notification type ───────────────────────────────

  it('handles unknown notification type gracefully', async () => {
    mockFindConnectionByChannelId.mockResolvedValue({
      id: 'conn-1',
      expertProfileId: EXPERT_ID,
    });

    const res = await injectWebhook({
      notification: { type: 'some_future_type' },
      channel: {
        channel_id: 'ch-1',
        callback_url: 'https://api.balo.test/webhooks/cronofy',
      },
    });
    await flush();

    expect(res.statusCode).toBe(200);
  });

  // ── Queue failure during enqueue ──────────────────────────────

  it('handles queue failure during cache rebuild enqueue', async () => {
    mockFindConnectionByChannelId.mockResolvedValue({
      id: 'conn-1',
      expertProfileId: EXPERT_ID,
    });
    mockQueueAdd.mockRejectedValue(new Error('Redis down'));

    const res = await injectWebhook({
      notification: { type: 'change' },
      channel: {
        channel_id: 'ch-1',
        callback_url: 'https://api.balo.test/webhooks/cronofy',
      },
    });
    await flush();

    // Should still return 200 — queue failure is logged
    expect(res.statusCode).toBe(200);
    expect(mockUpdateLastSyncedAt).toHaveBeenCalled();
  });
});
