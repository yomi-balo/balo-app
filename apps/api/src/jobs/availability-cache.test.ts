import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  },
  Queue: class MockQueue {},
}));

import {
  startAvailabilityCacheWorker,
  startStalenessCheckWorker,
  registerStalenessCheckCron,
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

      mockResolveAndCacheAvailability.mockResolvedValue({ earliestAvailableAt: null });

      await capturedAvailabilityProcessor!(mockJob);

      expect(mockResolveAndCacheAvailability).toHaveBeenCalledWith('expert-1');
      expect(mockTrackServer).toHaveBeenCalledWith('calendar_availability_cache_rebuilt', {
        distinct_id: 'expert-1',
      });
      expect(mockJob.log).toHaveBeenCalledWith(expect.stringContaining('expert-1'));
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
          removeOnFail: false,
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
});
