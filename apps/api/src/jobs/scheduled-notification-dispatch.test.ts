import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledNotification } from '@balo/db';

// ── Hoisted mocks ──────────────────────────────────────────────
const {
  mockListDue,
  mockClaim,
  mockMarkPublished,
  mockMarkSkipped,
  mockMarkFailed,
  mockPublish,
  mockRunRecheck,
  mockLogger,
} = vi.hoisted(() => ({
  mockListDue: vi.fn(),
  mockClaim: vi.fn(),
  mockMarkPublished: vi.fn(),
  mockMarkSkipped: vi.fn(),
  mockMarkFailed: vi.fn(),
  mockPublish: vi.fn(),
  mockRunRecheck: vi.fn(),
  // One STABLE logger instance (not a fresh object per createLogger call) so the
  // backlog `warn` is assertable.
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/db', () => ({
  scheduledNotificationsRepository: {
    listDue: mockListDue,
    claim: mockClaim,
    markPublished: mockMarkPublished,
    markSkipped: mockMarkSkipped,
    markFailed: mockMarkFailed,
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => mockLogger,
}));

vi.mock('../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));

// The real `UnknownRecheckError` class is kept — the tick branches on `instanceof`, so a
// stubbed class would make that branch untestable rather than tested.
vi.mock('../notifications/scheduling/rechecks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../notifications/scheduling/rechecks.js')>();
  return { ...actual, runRecheck: mockRunRecheck };
});

vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn(() => ({ add: vi.fn() })) }));
vi.mock('bullmq', () => ({ Worker: class MockWorker {} }));

import { UnknownRecheckError } from '../notifications/scheduling/rechecks.js';
import {
  runScheduledNotificationDispatch,
  SCHEDULED_NOTIFICATION_DISPATCH_CRON,
  SCHEDULED_NOTIFICATION_DISPATCH_QUEUE,
} from './scheduled-notification-dispatch.js';

const NOW = new Date('2026-08-05T12:00:00.000Z');

function row(overrides: Partial<ScheduledNotification> = {}): ScheduledNotification {
  return {
    id: 'row-1',
    dedupeKey: 'meeting_expert_absent:m-1',
    event: 'user.welcome',
    payload: { correlationId: 'c-1', stored: true },
    scheduledFor: new Date(NOW.getTime() - 60_000),
    status: 'pending',
    mode: 'first_wins',
    recheck: null,
    attempts: 0,
    claimedAt: null,
    publishedAt: null,
    cancelledAt: null,
    skipReason: null,
    lastError: null,
    createdAt: new Date(NOW.getTime() - 3_600_000),
    updatedAt: new Date(NOW.getTime() - 3_600_000),
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListDue.mockResolvedValue([]);
  mockClaim.mockImplementation(async ({ id }: { id: string }) => row({ id, status: 'claimed' }));
  mockMarkPublished.mockResolvedValue(undefined);
  mockMarkSkipped.mockResolvedValue(undefined);
  mockMarkFailed.mockResolvedValue(undefined);
  mockPublish.mockResolvedValue(undefined);
  mockRunRecheck.mockImplementation(async (r: ScheduledNotification) => ({
    publish: true,
    payload: r.payload,
  }));
});

describe('cron registration constants', () => {
  it('runs per-minute on its own queue', () => {
    expect(SCHEDULED_NOTIFICATION_DISPATCH_CRON).toBe('* * * * *');
    expect(SCHEDULED_NOTIFICATION_DISPATCH_QUEUE).toBe('scheduled-notification-dispatch');
  });
});

describe('runScheduledNotificationDispatch — the due scan', () => {
  it('asks for pending-due PLUS claimed rows stranded past the 5-minute TTL, oldest first', async () => {
    await runScheduledNotificationDispatch(NOW);

    // The TTL crosses as a POLICY value, never as a pre-computed cutoff: staleness is
    // judged on the DATABASE clock, so an app-side `now - ttl` would reopen the clock-skew
    // and slow-tick double-send windows.
    expect(mockListDue).toHaveBeenCalledWith({
      now: NOW,
      claimTtlMinutes: 5,
      limit: 200,
    });
  });

  it('WARNS when the batch fills — the post-outage backlog signal', async () => {
    const oldest = new Date(NOW.getTime() - 90 * 60_000);
    const backlog = Array.from({ length: 200 }, (_, i) =>
      row({ id: `row-${i}`, scheduledFor: i === 0 ? oldest : NOW })
    );
    mockListDue.mockResolvedValue(backlog);

    await runScheduledNotificationDispatch(NOW);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { limit: 200, oldestScheduledFor: oldest.toISOString() },
      expect.stringContaining('backlog')
    );
  });

  it('does NOT warn on a batch below the limit', async () => {
    mockListDue.mockResolvedValue([row()]);

    await runScheduledNotificationDispatch(NOW);

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('an empty batch publishes nothing and returns zero counts', async () => {
    const counts = await runScheduledNotificationDispatch(NOW);

    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(counts).toEqual({ published: 0, skipped: 0, failed: 0 });
  });
});

describe('runScheduledNotificationDispatch — the claim is the send-once gate', () => {
  it('claim returning undefined ⇒ PUBLISH IS NEVER CALLED', async () => {
    mockListDue.mockResolvedValue([row()]);
    mockClaim.mockResolvedValue(undefined);

    const counts = await runScheduledNotificationDispatch(NOW);

    // Lost the race, cancelled, not yet stale, attempts spent, or soft-deleted — every one
    // of them means "not yours to send".
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockRunRecheck).not.toHaveBeenCalled();
    expect(mockMarkPublished).not.toHaveBeenCalled();
    expect(counts).toEqual({ published: 0, skipped: 0, failed: 0 });
  });

  it('claims with the row id, the tick clock, the reclaim cutoff and the attempts ceiling', async () => {
    mockListDue.mockResolvedValue([row({ id: 'row-7' })]);

    await runScheduledNotificationDispatch(NOW);

    expect(mockClaim).toHaveBeenCalledWith({
      id: 'row-7',
      claimTtlMinutes: 5,
      maxAttempts: 3,
    });
  });

  it('a THROWING claim is logged and skipped, never swallowed into a publish', async () => {
    mockListDue.mockResolvedValue([row()]);
    mockClaim.mockRejectedValue(new Error('deadlock detected'));
    const log = vi.fn();

    const counts = await runScheduledNotificationDispatch(NOW, log);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('deadlock detected'));
    expect(counts).toEqual({ published: 0, skipped: 0, failed: 0 });
  });
});

describe('runScheduledNotificationDispatch — the fire-time recheck', () => {
  it('happy path: publishes then marks published', async () => {
    mockListDue.mockResolvedValue([row({ id: 'row-2' })]);

    const counts = await runScheduledNotificationDispatch(NOW);

    expect(mockPublish).toHaveBeenCalledWith('user.welcome', {
      correlationId: 'c-1',
      stored: true,
    });
    expect(mockMarkPublished).toHaveBeenCalledWith('row-2');
    expect(counts).toEqual({ published: 1, skipped: 0, failed: 0 });
  });

  it('publishes the payload the RECHECK returned, NOT the stored one', async () => {
    mockListDue.mockResolvedValue([row()]);
    const rebuilt = { correlationId: 'c-1', unreadCount: 4 };
    mockRunRecheck.mockResolvedValue({ publish: true, payload: rebuilt });

    await runScheduledNotificationDispatch(NOW);

    expect(mockPublish).toHaveBeenCalledWith('user.welcome', rebuilt);
  });

  it('{publish:false} ⇒ markSkipped with the reason, and NO publish (a normal outcome)', async () => {
    mockListDue.mockResolvedValue([row({ id: 'row-3' })]);
    mockRunRecheck.mockResolvedValue({ publish: false, reason: 'all_read' });

    const counts = await runScheduledNotificationDispatch(NOW);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockMarkSkipped).toHaveBeenCalledWith('row-3', 'all_read');
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(counts).toEqual({ published: 0, skipped: 1, failed: 0 });
  });

  it('UnknownRecheckError ⇒ terminal markFailed (fail CLOSED on deploy skew)', async () => {
    mockListDue.mockResolvedValue([row({ id: 'row-4', recheck: 'gone' })]);
    mockRunRecheck.mockRejectedValue(new UnknownRecheckError('gone'));

    const counts = await runScheduledNotificationDispatch(NOW);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith('row-4', expect.stringContaining('gone'));
    expect(counts).toEqual({ published: 0, skipped: 0, failed: 1 });
  });

  it('a recheck payload with NO correlationId FAILS CLOSED — never published', async () => {
    mockListDue.mockResolvedValue([row({ id: 'row-8', recheck: 'conversation_unread' })]);
    // Decision 6 actively encourages rebuilding the payload from live state, and
    // `Record<string, unknown>` cannot require `correlationId` — so a consumer can drop it.
    mockRunRecheck.mockResolvedValue({ publish: true, payload: { unreadCount: 3 } });

    const counts = await runScheduledNotificationDispatch(NOW);

    // Publishing it would mint jobId `event--undefined`, collapsing EVERY promise of this
    // event into one BullMQ job for as long as it sat in the completed set: the second
    // alert silently never sent, AND the row marked `published`. Terminal `failed` instead.
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockMarkPublished).not.toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith('row-8', expect.stringContaining('correlationId'));
    expect(counts).toEqual({ published: 0, skipped: 0, failed: 1 });
  });

  it.each([
    ['an empty string', ''],
    ['a number', 42],
    ['null', null],
  ])('a correlationId that is %s is rejected too', async (_label, correlationId) => {
    mockListDue.mockResolvedValue([row({ id: 'row-8' })]);
    mockRunRecheck.mockResolvedValue({ publish: true, payload: { correlationId } });

    const counts = await runScheduledNotificationDispatch(NOW);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(counts).toEqual({ published: 0, skipped: 0, failed: 1 });
  });

  it('a recheck that SPREADS the stored payload keeps correlationId and publishes', async () => {
    mockListDue.mockResolvedValue([row({ id: 'row-9' })]);
    mockRunRecheck.mockImplementation(async (r: ScheduledNotification) => ({
      publish: true,
      payload: { ...r.payload, unreadCount: 3 },
    }));

    const counts = await runScheduledNotificationDispatch(NOW);

    // The documented safe practice for a consumer writing a recheck.
    expect(mockPublish).toHaveBeenCalledWith('user.welcome', {
      correlationId: 'c-1',
      stored: true,
      unreadCount: 3,
    });
    expect(counts).toEqual({ published: 1, skipped: 0, failed: 0 });
  });

  it('any OTHER recheck throw leaves the row `claimed` — no terminal mark, no publish', async () => {
    mockListDue.mockResolvedValue([row({ id: 'row-5' })]);
    mockRunRecheck.mockRejectedValue(new Error('db blip'));

    const counts = await runScheduledNotificationDispatch(NOW);

    // Retried after the claim TTL; a transient blip must not consume the notification.
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockMarkSkipped).not.toHaveBeenCalled();
    expect(mockMarkPublished).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(counts).toEqual({ published: 0, skipped: 0, failed: 0 });
  });

  it('a THROWING publish leaves the row `claimed` — never marked published', async () => {
    mockListDue.mockResolvedValue([row()]);
    mockPublish.mockRejectedValue(new Error('redis down'));

    const counts = await runScheduledNotificationDispatch(NOW);

    expect(mockMarkPublished).not.toHaveBeenCalled();
    expect(counts).toEqual({ published: 0, skipped: 0, failed: 0 });
  });
});

describe('runScheduledNotificationDispatch — attempts ceiling', () => {
  it('a stale-claimed row AT the ceiling is terminal `failed` and is never re-claimed', async () => {
    mockListDue.mockResolvedValue([
      row({ id: 'row-6', status: 'claimed', attempts: 3, claimedAt: new Date(0) }),
    ]);

    const counts = await runScheduledNotificationDispatch(NOW);

    // Without this the row would be unclaimable (claim requires attempts < max) and would
    // sit `claimed` forever, re-selected by every tick and never resolved.
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith('row-6', expect.stringContaining('3 attempts'));
    expect(mockPublish).not.toHaveBeenCalled();
    expect(counts).toEqual({ published: 0, skipped: 0, failed: 1 });
  });

  it('a row BELOW the ceiling is still claimed', async () => {
    mockListDue.mockResolvedValue([
      row({ id: 'row-6', status: 'claimed', attempts: 2, claimedAt: new Date(0) }),
    ]);

    await runScheduledNotificationDispatch(NOW);

    expect(mockClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 'row-6' }));
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });
});

describe('runScheduledNotificationDispatch — batch isolation', () => {
  it('ONE BAD ROW NEVER ABORTS THE BATCH', async () => {
    mockListDue.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]);
    mockClaim.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'b') throw new Error('row b exploded');
      return row({ id, status: 'claimed' });
    });
    const log = vi.fn();

    const counts = await runScheduledNotificationDispatch(NOW, log);

    expect(mockMarkPublished).toHaveBeenCalledWith('a');
    expect(mockMarkPublished).toHaveBeenCalledWith('c');
    expect(counts).toEqual({ published: 2, skipped: 0, failed: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('row b exploded'));
  });

  it('counts a mixed batch correctly', async () => {
    mockListDue.mockResolvedValue([
      row({ id: 'pub' }),
      row({ id: 'skip' }),
      row({ id: 'dead', recheck: 'gone' }),
    ]);
    mockRunRecheck.mockImplementation(async (r: ScheduledNotification) => {
      if (r.id === 'skip') return { publish: false, reason: 'all_read' };
      if (r.id === 'dead') throw new UnknownRecheckError('gone');
      return { publish: true, payload: r.payload };
    });

    const counts = await runScheduledNotificationDispatch(NOW);

    expect(counts).toEqual({ published: 1, skipped: 1, failed: 1 });
  });
});
