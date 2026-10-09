import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAdd = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  getQueue: vi.fn(() => ({ add: mockAdd })),
}));

import { notificationEvents } from './publisher.js';
import { getQueue } from '../lib/queue.js';
import { buildExpertApplicationSubmittedPayload } from '@balo/shared/notifications';

describe('notificationEvents.publish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The dedup-double tests below install a custom `mockImplementation`; restore the plain
    // resolved-value default so it never leaks into an unrelated test.
    mockAdd.mockReset().mockResolvedValue(undefined);
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
    // The regression this pins: credit correlationIds ARE ledger idempotency keys, and those
    // are colon-joined (`manual_purchase:{piId}`). BullMQ rejects a jobId whose colon count is
    // not 0 or exactly 2 (a legacy repeatable-job carve-out — see buildJobId's docblock), so the
    // one-colon and 3+-colon shapes had never delivered a notification; it surfaced only as a
    // best-effort log line beside an already-committed money effect, which is why it went
    // unnoticed. The pre-existing cases above all use colon-free ids, so they could never
    // have caught it.
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
        jobId: 'expert.application__submitted--app-456',
      })
    );
  });

  /**
   * BAL-557 — a RESUBMISSION after a decline + reopen must not be deduped away against
   * the first submission's retained BullMQ job. This double REPRODUCES BullMQ's own dedup
   * semantics (`queue.add` with a jobId it has already seen is a silent no-op), so it is a real
   * arbiter for the assertion, not a tautology — the "characterises the bug" case below proves
   * the SAME double collapses two adds sharing one jobId down to one.
   */
  describe('expert.application_submitted — per-write dedup identity', () => {
    function installDedupDouble(): Set<string> {
      const seen = new Set<string>();
      mockAdd.mockImplementation(async (_name: string, _data: unknown, opts: { jobId: string }) => {
        if (seen.has(opts.jobId)) return undefined;
        seen.add(opts.jobId);
        return undefined;
      });
      return seen;
    }

    it('two submits with distinct audit ids reach the dedup double as TWO jobs', async () => {
      const seen = installDedupDouble();
      const first = buildExpertApplicationSubmittedPayload({
        userId: 'user-1',
        expertProfileId: 'profile-1',
        auditEventId: 'audit-1',
      });
      const second = buildExpertApplicationSubmittedPayload({
        userId: 'user-1',
        expertProfileId: 'profile-1',
        auditEventId: 'audit-2',
      });
      expect(first.correlationId).not.toBe(second.correlationId);

      await notificationEvents.publish('expert.application_submitted', first);
      await notificationEvents.publish('expert.application_submitted', second);

      expect(seen.size).toBe(2);
    });

    it('characterises the bug: a per-profile correlationId collapses two submits onto ONE job', async () => {
      const seen = installDedupDouble();
      const buggyPayload = {
        correlationId: 'profile-1',
        userId: 'user-1',
        applicationId: 'profile-1',
      };

      await notificationEvents.publish('expert.application_submitted', buggyPayload);
      await notificationEvents.publish('expert.application_submitted', buggyPayload);

      expect(seen.size).toBe(1);
    });
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
