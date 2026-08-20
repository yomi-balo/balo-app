import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockListExpiringBefore,
  mockListUnconfirmedBefore,
  mockListActiveConnectionsWithoutSubscription,
  mockTrackServer,
  mockPublish,
  mockEnqueueSubscriptionReconcile,
  mockErrorLog,
  mockWarnLog,
} = vi.hoisted(() => ({
  mockListExpiringBefore: vi.fn(),
  mockListUnconfirmedBefore: vi.fn(),
  mockListActiveConnectionsWithoutSubscription: vi.fn(),
  mockTrackServer: vi.fn(),
  mockPublish: vi.fn(),
  mockEnqueueSubscriptionReconcile: vi.fn(),
  mockErrorLog: vi.fn(),
  mockWarnLog: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  calendarSubscriptionsRepository: {
    listExpiringBefore: mockListExpiringBefore,
    listUnconfirmedBefore: mockListUnconfirmedBefore,
    listActiveConnectionsWithoutSubscription: mockListActiveConnectionsWithoutSubscription,
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarnLog, error: mockErrorLog }),
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  CALENDAR_SERVER_EVENTS: { SUBSCRIPTION_LAPSE_DETECTED: 'calendar_subscription_lapse_detected' },
}));

vi.mock('../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));

vi.mock('./calendar-subscription-reconcile.js', () => ({
  enqueueSubscriptionReconcile: mockEnqueueSubscriptionReconcile,
}));

vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn(() => ({ add: vi.fn() })) }));

const { runCalendarSubscriptionMonitor, SUBSCRIPTION_EXPIRY_ALERT_MS } =
  await import('./calendar-subscription-monitor.js');

const NOW = new Date('2026-08-19T07:00:00.000Z');

describe('calendar-subscription-monitor (BAL-468 §12)', () => {
  const original = process.env.APIROC_WEBHOOK_BASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APIROC_WEBHOOK_BASE_URL = 'https://api.balo.expert';
    mockListExpiringBefore.mockResolvedValue([]);
    mockListUnconfirmedBefore.mockResolvedValue([]);
    mockListActiveConnectionsWithoutSubscription.mockResolvedValue([]);
    mockPublish.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (original === undefined) delete process.env.APIROC_WEBHOOK_BASE_URL;
    else process.env.APIROC_WEBHOOK_BASE_URL = original;
  });

  it('exposes the expiry-alert threshold', () => {
    expect(SUBSCRIPTION_EXPIRY_ALERT_MS).toBe(48 * 60 * 60 * 1000);
  });

  it('no alert when all three arms are zero', async () => {
    const result = await runCalendarSubscriptionMonitor(NOW);
    expect(result.alerted).toBe(false);
    expect(mockErrorLog).not.toHaveBeenCalledWith(
      expect.anything(),
      'apiroc_subscription_expiry_alert'
    );
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('alerts when arm 1 (expiring) is non-zero', async () => {
    mockListExpiringBefore.mockResolvedValue([{ id: 'sub-1', connectionId: 'conn-1' }]);

    const result = await runCalendarSubscriptionMonitor(NOW);

    expect(result.alerted).toBe(true);
    expect(mockErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ expiringCount: 1 }),
      'apiroc_subscription_expiry_alert'
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'calendar_subscription_lapse_detected',
      expect.objectContaining({ expiring_count: 1, distinct_id: 'system:calendar-subscriptions' })
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'calendar.subscription_lapse',
      expect.objectContaining({ correlationId: 'calendar_subscription_lapse:2026-08-19' })
    );
  });

  it('alerts when arm 2 (unconfirmed) is non-zero', async () => {
    mockListUnconfirmedBefore.mockResolvedValue([{ id: 'sub-2', connectionId: 'conn-2' }]);
    const result = await runCalendarSubscriptionMonitor(NOW);
    expect(result.alerted).toBe(true);
  });

  it('⚠⚠ ALL THREE ARMS are gated on APIROC_WEBHOOK_BASE_URL — no read, no alert, no publish, no self-heal', async () => {
    // Merge day is only half the reason. The other half is §17's REVERT: "unset
    // APIROC_WEBHOOK_BASE_URL and redeploy". With rows still in the table and reconcile
    // switched off, every row crosses the 48h threshold within days — so an ungated arm 1
    // would page daily, forever, with a self-heal that provably cannot repair anything.
    delete process.env.APIROC_WEBHOOK_BASE_URL;
    mockListExpiringBefore.mockResolvedValue([{ id: 'sub-1', connectionId: 'conn-1' }]);
    mockListUnconfirmedBefore.mockResolvedValue([{ id: 'sub-2', connectionId: 'conn-2' }]);
    mockListActiveConnectionsWithoutSubscription.mockResolvedValue([
      { connectionId: 'conn-3', expertProfileId: 'expert-3' },
    ]);

    const result = await runCalendarSubscriptionMonitor(NOW);

    // Not one of the three reads is issued.
    expect(mockListExpiringBefore).not.toHaveBeenCalled();
    expect(mockListUnconfirmedBefore).not.toHaveBeenCalled();
    expect(mockListActiveConnectionsWithoutSubscription).not.toHaveBeenCalled();

    expect(result.expiringCount).toBe(0);
    expect(result.unconfirmedCount).toBe(0);
    expect(result.unsubscribedConnectionCount).toBe(0);
    expect(result.alerted).toBe(false);
    expect(result.selfHealed).toBe(0);
    expect(mockPublish).not.toHaveBeenCalled();
    // ⚠ and no self-heal enqueue either — enqueuing a reconcile that is switched off is pure
    // churn, and it is what made the ungated version look like it was "trying".
    expect(mockEnqueueSubscriptionReconcile).not.toHaveBeenCalled();
  });

  it('arm 3 alerts when configured and non-zero', async () => {
    mockListActiveConnectionsWithoutSubscription.mockResolvedValue([
      { connectionId: 'conn-3', expertProfileId: 'expert-3' },
    ]);
    const result = await runCalendarSubscriptionMonitor(NOW);
    expect(result.alerted).toBe(true);
    expect(result.unsubscribedConnectionCount).toBe(1);
  });

  it('warns when a batch fills (no silent caps)', async () => {
    const filled = Array.from({ length: 500 }, (_, i) => ({
      id: `sub-${i}`,
      connectionId: `conn-${i}`,
    }));
    mockListExpiringBefore.mockResolvedValue(filled);

    await runCalendarSubscriptionMonitor(NOW);

    expect(mockWarnLog).toHaveBeenCalledWith(
      expect.objectContaining({ arm: 'expiring', limit: 500 }),
      'apiroc_subscription_monitor_batch_filled'
    );
  });

  it('self-heals: enqueues a reconcile ONCE per distinct connection id across all arms', async () => {
    mockListExpiringBefore.mockResolvedValue([{ id: 'sub-1', connectionId: 'conn-1' }]);
    mockListUnconfirmedBefore.mockResolvedValue([{ id: 'sub-2', connectionId: 'conn-1' }]);
    mockListActiveConnectionsWithoutSubscription.mockResolvedValue([
      { connectionId: 'conn-2', expertProfileId: 'expert-2' },
    ]);

    const result = await runCalendarSubscriptionMonitor(NOW);

    expect(mockEnqueueSubscriptionReconcile).toHaveBeenCalledTimes(2);
    expect(mockEnqueueSubscriptionReconcile).toHaveBeenCalledWith(
      'conn-1',
      { force: false },
      expect.anything()
    );
    expect(mockEnqueueSubscriptionReconcile).toHaveBeenCalledWith(
      'conn-2',
      { force: false },
      expect.anything()
    );
    // The alert still fires even though a repair was attempted — it never suppresses.
    expect(result.alerted).toBe(true);
    expect(result.selfHealed).toBe(2);
  });
});

describe('calendar-subscription-monitor — module-load coupling assertions', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws when SUBSCRIPTION_RENEWAL_LEAD_MS is not strictly greater than the alert threshold', async () => {
    vi.doMock('../services/calendar/subscription-plan.js', () => ({
      SUBSCRIPTION_RENEWAL_LEAD_MS: 1000, // far below the real 48h alert threshold
    }));
    vi.doMock('./calendar-health-probe.js', () => ({ PROBE_INTERVAL_MS: 1 }));
    vi.doMock('@balo/db', () => ({ calendarSubscriptionsRepository: {} }));
    vi.doMock('@balo/shared/logging', () => ({
      createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
    }));
    vi.doMock('@balo/analytics/server', () => ({
      trackServer: vi.fn(),
      CALENDAR_SERVER_EVENTS: {},
    }));
    vi.doMock('../notifications/publisher.js', () => ({
      notificationEvents: { publish: vi.fn() },
    }));
    vi.doMock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
    vi.doMock('../lib/queue.js', () => ({ getQueue: vi.fn() }));

    await expect(import('./calendar-subscription-monitor.js')).rejects.toThrow();
  });

  it('throws when PROBE_INTERVAL_MS is not strictly less than the alert threshold', async () => {
    vi.doMock('../services/calendar/subscription-plan.js', () => ({
      SUBSCRIPTION_RENEWAL_LEAD_MS: 72 * 60 * 60 * 1000,
    }));
    vi.doMock('./calendar-health-probe.js', () => ({ PROBE_INTERVAL_MS: 48 * 60 * 60 * 1000 }));
    vi.doMock('@balo/db', () => ({ calendarSubscriptionsRepository: {} }));
    vi.doMock('@balo/shared/logging', () => ({
      createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
    }));
    vi.doMock('@balo/analytics/server', () => ({
      trackServer: vi.fn(),
      CALENDAR_SERVER_EVENTS: {},
    }));
    vi.doMock('../notifications/publisher.js', () => ({
      notificationEvents: { publish: vi.fn() },
    }));
    vi.doMock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
    vi.doMock('../lib/queue.js', () => ({ getQueue: vi.fn() }));

    await expect(import('./calendar-subscription-monitor.js')).rejects.toThrow();
  });
});
