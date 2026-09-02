import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAdd = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/queue.js', () => ({
  getQueue: vi.fn(() => ({ add: mockAdd })),
}));

import { notificationEvents } from './publisher.js';
import { getQueue } from '../lib/queue.js';

describe('notificationEvents.publish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes user.welcome event with correct job name, data, and jobId', async () => {
    const payload = {
      correlationId: 'user-123',
      userId: 'user-123',
      role: 'client' as const,
    };

    await notificationEvents.publish('user.welcome', payload);

    expect(getQueue).toHaveBeenCalledWith('notification-events');
    expect(mockAdd).toHaveBeenCalledWith(
      'user.welcome',
      expect.objectContaining({
        event: 'user.welcome',
        payload,
        publishedAt: expect.any(String),
      }),
      expect.objectContaining({
        jobId: 'user.welcome--user-123',
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      })
    );
  });

  it('sanitises colons out of the jobId — BullMQ rejects them outright', async () => {
    // The regression this pins: every credit correlationId IS a ledger idempotency key, and
    // those are colon-joined (`manual_purchase:{piId}`). BullMQ throws "Custom Id cannot
    // contain :" on such an id, so EVERY credit publish failed — no top-up receipt, dunning
    // notice or settlement notification was ever delivered. It surfaced only as a best-effort
    // log line beside an already-committed money effect, which is why it went unnoticed.
    // The existing cases above all use colon-free ids, so they could never have caught it.
    await notificationEvents.publish('credit.topup.completed', {
      correlationId: 'manual_purchase:pi_3UB4aV2NflDPoiWN0G8yaIxz',
    } as never);

    const [, , opts] = mockAdd.mock.calls[0] as [unknown, unknown, { jobId: string }];
    expect(opts.jobId).not.toContain(':');
    // `_` is escaped to `__` FIRST, so the mapping is injective for any future reason name.
    expect(opts.jobId).toBe(
      'credit.topup.completed--manual__purchase_cpi__3UB4aV2NflDPoiWN0G8yaIxz'
    );
  });

  it('keeps distinct correlationIds distinct after sanitising (dedup is not weakened)', async () => {
    // Two different auto-top-up keys must not collapse onto one job id, or the second
    // notification would be silently deduped away as a replay of the first.
    await notificationEvents.publish('credit.topup.completed', {
      correlationId: 'auto_topup:wallet-a:entry-1',
    } as never);
    await notificationEvents.publish('credit.topup.completed', {
      correlationId: 'auto_topup:wallet-a:entry-2',
    } as never);

    const ids = mockAdd.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
    expect(new Set(ids).size).toBe(2);
  });

  it('stays injective when _ and : appear in swapped order (the escape-collision case)', async () => {
    // The case a two-pass `_`→`__` then `:`→`_` escape gets WRONG: both of these collapse to
    // `a___b`, because the replacement for `:` is a single `_` that merges with the escaped
    // pair. Only a 2-char escape whose second character disambiguates survives this.
    await notificationEvents.publish('credit.topup.completed', {
      correlationId: 'a_:b',
    } as never);
    await notificationEvents.publish('credit.topup.completed', {
      correlationId: 'a:_b',
    } as never);

    const ids = mockAdd.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
    expect(new Set(ids).size).toBe(2);
  });

  it('stays injective for reason names that would collide under a naive : → _ swap', async () => {
    // The hazard the escape closes: `manual:x` and `manual_x` both become `manual_x` if `:` is
    // replaced without escaping `_` first, silently merging two notifications into one job.
    await notificationEvents.publish('credit.topup.completed', {
      correlationId: 'manual:x',
    } as never);
    await notificationEvents.publish('credit.topup.completed', {
      correlationId: 'manual_x',
    } as never);

    const ids = mockAdd.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => !id.includes(':'))).toBe(true);
  });

  it('publishes expert.application_submitted event with correct jobId format', async () => {
    const payload = {
      correlationId: 'app-456',
      userId: 'user-789',
      applicationId: 'app-456',
    };

    await notificationEvents.publish('expert.application_submitted', payload);

    expect(mockAdd).toHaveBeenCalledWith(
      'expert.application_submitted',
      expect.objectContaining({
        event: 'expert.application_submitted',
        payload,
      }),
      expect.objectContaining({
        jobId: 'expert.application_submitted--app-456',
      })
    );
  });

  it('includes ISO timestamp in publishedAt', async () => {
    const before = new Date().toISOString();

    await notificationEvents.publish('user.welcome', {
      correlationId: 'user-1',
      userId: 'user-1',
      role: 'client' as const,
    });

    const after = new Date().toISOString();
    const publishedAt = mockAdd.mock.calls[0][1].publishedAt;

    expect(publishedAt >= before).toBe(true);
    expect(publishedAt <= after).toBe(true);
  });
});
