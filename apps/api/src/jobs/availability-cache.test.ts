import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

// ── Hoisted mocks ──────────────────────────────────────────────

const { mockResolveAndCacheAvailability, mockFindStaleConnections, mockQueueAdd, mockTrackServer } =
  vi.hoisted(() => ({
    mockResolveAndCacheAvailability: vi.fn(),
    mockFindStaleConnections: vi.fn(),
    mockQueueAdd: vi.fn(),
    mockTrackServer: vi.fn(),
  }));

vi.mock('@balo/db', () => ({
  calendarRepository: {
    findStaleConnections: mockFindStaleConnections,
  },
}));

vi.mock('../services/availability/resolve-and-cache.js', () => ({
  resolveAndCacheAvailability: mockResolveAndCacheAvailability,
}));

vi.mock('../lib/redis.js', () => ({
  createRedisConnection: () => ({}),
}));

vi.mock('../lib/queue.js', () => ({
  getQueue: vi.fn(() => ({ add: mockQueueAdd })),
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  CALENDAR_SERVER_EVENTS: {
    AVAILABILITY_CACHE_REBUILT: 'calendar_availability_cache_rebuilt',
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock BullMQ Worker to capture the processor function
let capturedAvailabilityProcessor: ((job: unknown) => Promise<void>) | null = null;
let capturedStalenessProcessor: ((job: unknown) => Promise<void>) | null = null;

vi.mock('bullmq', () => ({
  Worker: class MockWorker {
    constructor(name: string, processor: (job: unknown) => Promise<void>) {
      if (name === 'rebuild-availability-cache') {
        capturedAvailabilityProcessor = processor;
      } else if (name === 'staleness-check') {
        capturedStalenessProcessor = processor;
      }
    }
    // The availability worker registers a `failed` listener for observability.
    on(): void {}
  },
  Queue: class MockQueue {},
}));

import {
  startAvailabilityCacheWorker,
  startStalenessCheckWorker,
  registerStalenessCheckCron,
  enqueueAvailabilityCacheRebuild,
  tryEnqueueAvailabilityCacheRebuild,
  AVAILABILITY_CACHE_QUEUE,
  STALENESS_CHECK_QUEUE,
} from './availability-cache';

describe('availability-cache jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedAvailabilityProcessor = null;
    capturedStalenessProcessor = null;
  });

  describe('constants', () => {
    it('exports correct queue names', () => {
      expect(AVAILABILITY_CACHE_QUEUE).toBe('rebuild-availability-cache');
      expect(STALENESS_CHECK_QUEUE).toBe('staleness-check');
    });
  });

  describe('startAvailabilityCacheWorker', () => {
    it('delegates to resolveAndCacheAvailability and emits the analytics event', async () => {
      startAvailabilityCacheWorker();

      expect(capturedAvailabilityProcessor).toBeDefined();

      const mockJob = {
        data: { expertProfileId: 'expert-1' },
        log: vi.fn(),
      };

      mockResolveAndCacheAvailability.mockResolvedValue({
        status: 'completed',
        earliestAvailableAt: null,
      });

      await capturedAvailabilityProcessor!(mockJob);

      expect(mockResolveAndCacheAvailability).toHaveBeenCalledWith('expert-1');
      expect(mockTrackServer).toHaveBeenCalledWith('calendar_availability_cache_rebuilt', {
        distinct_id: 'expert-1',
      });
      expect(mockJob.log).toHaveBeenCalledWith(expect.stringContaining('expert-1'));
    });

    /**
     * ⚠⚠ round-2 fix #11 — THE SKIP-VS-COMPLETED REGRESSION TEST. Before this fix the worker
     * reported a SKIPPED rebuild (expert settings missing, or the vendor busy read was
     * untrustworthy) IDENTICALLY to a completed one: same job.log line, same
     * `AVAILABILITY_CACHE_REBUILT` analytics fire — indistinguishable from a genuine success
     * in every log and every dashboard.
     */
    it('does NOT fire AVAILABILITY_CACHE_REBUILT, and logs a distinguishable message, when the rebuild is SKIPPED', async () => {
      startAvailabilityCacheWorker();

      const mockJob = {
        data: { expertProfileId: 'expert-1' },
        log: vi.fn(),
      };

      mockResolveAndCacheAvailability.mockResolvedValue({
        status: 'skipped',
        skipReason: 'vendor_busy_unavailable',
        earliestAvailableAt: null,
      });

      await capturedAvailabilityProcessor!(mockJob);

      expect(mockTrackServer).not.toHaveBeenCalled();
      const [loggedMessage] = mockJob.log.mock.calls[0] as [string];
      expect(loggedMessage).toContain('SKIPPED');
      expect(loggedMessage).toContain('vendor_busy_unavailable');
    });
  });

  describe('startStalenessCheckWorker', () => {
    it('creates a worker that checks for stale connections', async () => {
      startStalenessCheckWorker();

      expect(capturedStalenessProcessor).toBeDefined();

      const mockJob = { log: vi.fn() };
      mockFindStaleConnections.mockResolvedValue([]);

      await capturedStalenessProcessor!(mockJob);

      expect(mockFindStaleConnections).toHaveBeenCalled();
      expect(mockJob.log).toHaveBeenCalledWith('No stale connections found');
    });

    it('enqueues rebuild jobs for stale connections', async () => {
      startStalenessCheckWorker();

      const mockJob = { log: vi.fn() };
      mockFindStaleConnections.mockResolvedValue([
        { expertProfileId: 'expert-1' },
        { expertProfileId: 'expert-2' },
      ]);
      mockQueueAdd.mockResolvedValue(undefined);

      await capturedStalenessProcessor!(mockJob);

      expect(mockQueueAdd).toHaveBeenCalledTimes(2);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'rebuild-availability-cache',
        { expertProfileId: 'expert-1' },
        expect.objectContaining({
          jobId: 'availability-expert-1',
          removeOnComplete: true,
          removeOnFail: true,
        })
      );
      expect(mockJob.log).toHaveBeenCalledWith('Enqueued 2 stale connection rebuild jobs');
    });
  });

  describe('registerStalenessCheckCron', () => {
    it('adds a repeating job to the staleness check queue', async () => {
      mockQueueAdd.mockResolvedValue(undefined);

      await registerStalenessCheckCron();

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'check',
        {},
        expect.objectContaining({
          repeat: { pattern: '*/15 * * * *' },
          removeOnComplete: true,
        })
      );
    });
  });

  describe('enqueueAvailabilityCacheRebuild', () => {
    const makeLog = (): FastifyBaseLogger => ({ error: vi.fn() }) as unknown as FastifyBaseLogger;

    it('enqueues with the coalescing jobId and self-heal options', async () => {
      const log = makeLog();

      await enqueueAvailabilityCacheRebuild('expert-1', log);

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'rebuild-availability-cache',
        { expertProfileId: 'expert-1' },
        {
          jobId: 'availability-expert-1',
          removeOnComplete: true,
          // removeOnFail: true so a terminal failure can't wedge the fixed jobId.
          removeOnFail: true,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        }
      );
      expect(log.error).not.toHaveBeenCalled();
    });

    it('logs and swallows enqueue failures (never throws)', async () => {
      const log = makeLog();
      mockQueueAdd.mockRejectedValueOnce(new Error('redis down'));

      await expect(enqueueAvailabilityCacheRebuild('expert-1', log)).resolves.toBeUndefined();

      expect(log.error).toHaveBeenCalledWith(
        { expertProfileId: 'expert-1', error: 'redis down' },
        'Failed to enqueue availability cache rebuild job'
      );
    });
  });

  describe('tryEnqueueAvailabilityCacheRebuild (BAL-468 §7.4)', () => {
    const makeLog = (): FastifyBaseLogger => ({ error: vi.fn() }) as unknown as FastifyBaseLogger;

    it('returns true and enqueues with the same coalescing options on success', async () => {
      const log = makeLog();

      const result = await tryEnqueueAvailabilityCacheRebuild('expert-1', log);

      expect(result).toBe(true);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'rebuild-availability-cache',
        { expertProfileId: 'expert-1' },
        expect.objectContaining({ jobId: 'availability-expert-1' })
      );
    });

    it('returns false on a queue error, and still swallows (does not throw)', async () => {
      const log = makeLog();
      mockQueueAdd.mockRejectedValueOnce(new Error('redis down'));

      const result = await tryEnqueueAvailabilityCacheRebuild('expert-1', log);

      expect(result).toBe(false);
      expect(log.error).toHaveBeenCalled();
    });

    it('enqueueAvailabilityCacheRebuild still swallows and returns void regardless of the result', async () => {
      const log = makeLog();
      mockQueueAdd.mockRejectedValueOnce(new Error('redis down'));

      await expect(enqueueAvailabilityCacheRebuild('expert-1', log)).resolves.toBeUndefined();
    });
  });
});
