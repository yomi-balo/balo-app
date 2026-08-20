import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const { mockQueueAdd, mockFindConnectionById, mockReconcile } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockFindConnectionById: vi.fn(),
  mockReconcile: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  calendarRepository: {
    findConnectionById: mockFindConnectionById,
  },
}));

vi.mock('../lib/redis.js', () => ({
  createRedisConnection: () => ({}),
}));

vi.mock('../lib/queue.js', () => ({
  getQueue: vi.fn(() => ({ add: mockQueueAdd })),
}));

vi.mock('../services/calendar/subscription-reconcile.js', () => ({
  reconcileConnectionSubscriptions: mockReconcile,
}));

let capturedProcessor: ((job: unknown) => Promise<void>) | null = null;

vi.mock('bullmq', () => ({
  Worker: class MockWorker {
    constructor(_name: string, processor: (job: unknown) => Promise<void>) {
      capturedProcessor = processor;
    }
    on(): void {}
  },
  Queue: class MockQueue {},
}));

import {
  enqueueSubscriptionReconcile,
  startCalendarSubscriptionReconcileWorker,
  CALENDAR_SUBSCRIPTION_RECONCILE_QUEUE,
} from './calendar-subscription-reconcile.js';

describe('calendar-subscription-reconcile job (BAL-468 §8.4)', () => {
  const makeLog = (): FastifyBaseLogger => ({ error: vi.fn() }) as unknown as FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcessor = null;
  });

  it('exports the queue name', () => {
    expect(CALENDAR_SUBSCRIPTION_RECONCILE_QUEUE).toBe('calendar-subscription-reconcile');
  });

  describe('enqueueSubscriptionReconcile', () => {
    it('⚠⚠ non-force and force enqueues use SEPARATE jobId lanes', async () => {
      await enqueueSubscriptionReconcile('conn-1', { force: false }, makeLog());
      await enqueueSubscriptionReconcile('conn-1', { force: true }, makeLog());

      expect(mockQueueAdd).toHaveBeenNthCalledWith(
        1,
        'reconcile',
        { connectionId: 'conn-1', force: false },
        expect.objectContaining({ jobId: 'subscriptions-conn-1' })
      );
      expect(mockQueueAdd).toHaveBeenNthCalledWith(
        2,
        'reconcile',
        { connectionId: 'conn-1', force: true },
        expect.objectContaining({ jobId: 'subscriptions-force-conn-1' })
      );
    });

    it('sets removeOnFail: true so a terminal failure cannot wedge the lane', async () => {
      await enqueueSubscriptionReconcile('conn-1', { force: false }, makeLog());
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'reconcile',
        expect.anything(),
        expect.objectContaining({ removeOnFail: true, attempts: 3 })
      );
    });

    it('swallows an enqueue error (best-effort, matches enqueueAvailabilityCacheRebuild)', async () => {
      const log = makeLog();
      mockQueueAdd.mockRejectedValueOnce(new Error('redis down'));

      await expect(
        enqueueSubscriptionReconcile('conn-1', { force: false }, log)
      ).resolves.toBeUndefined();
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('the worker', () => {
    it('skips a connection that no longer resolves (soft-deleted or gone)', async () => {
      mockFindConnectionById.mockResolvedValue(undefined);
      startCalendarSubscriptionReconcileWorker();

      const mockJob = { data: { connectionId: 'conn-1', force: false }, log: vi.fn() };
      await capturedProcessor?.(mockJob);

      expect(mockReconcile).not.toHaveBeenCalled();
      expect(mockJob.log).toHaveBeenCalledWith(expect.stringContaining('is gone'));
    });

    it('calls reconcileConnectionSubscriptions with the loaded connection and force flag', async () => {
      const connection = { id: 'conn-1', credentialStatus: 'ACTIVE' };
      mockFindConnectionById.mockResolvedValue(connection);
      mockReconcile.mockResolvedValue({
        skipped: null,
        created: 1,
        renewed: 0,
        deleted: 0,
        deleteFailures: 0,
        unverifiedDeletes: 0,
        stamped: 0,
        missingAtVendor: 0,
        cappedActions: 0,
      });
      startCalendarSubscriptionReconcileWorker();

      const mockJob = { data: { connectionId: 'conn-1', force: true }, log: vi.fn() };
      await capturedProcessor?.(mockJob);

      expect(mockReconcile).toHaveBeenCalledWith(connection, { force: true });
      expect(mockJob.log).toHaveBeenCalledWith(expect.stringContaining('created=1'));
    });
  });
});
