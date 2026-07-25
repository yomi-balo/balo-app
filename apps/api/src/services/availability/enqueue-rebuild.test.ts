import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

// ── Hoisted mocks ──────────────────────────────────────────────

const { mockGetQueue, mockQueueAdd } = vi.hoisted(() => ({
  mockGetQueue: vi.fn(),
  mockQueueAdd: vi.fn(),
}));

vi.mock('../../lib/queue.js', () => ({
  getQueue: (...args: unknown[]) => {
    mockGetQueue(...args);
    return { add: mockQueueAdd };
  },
}));

// Keep the real queue-name constant but avoid pulling the whole job graph.
vi.mock('../../jobs/availability-cache.js', () => ({
  AVAILABILITY_CACHE_QUEUE: 'rebuild-availability-cache',
}));

import { enqueueAvailabilityCacheRebuild } from './enqueue-rebuild';

const EXPERT_ID = '550e8400-e29b-41d4-a716-446655440000';
const makeLog = (): FastifyBaseLogger => ({ error: vi.fn() }) as unknown as FastifyBaseLogger;

describe('enqueueAvailabilityCacheRebuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues a rebuild job with the coalescing jobId', async () => {
    const log = makeLog();

    await enqueueAvailabilityCacheRebuild(EXPERT_ID, log);

    expect(mockGetQueue).toHaveBeenCalledWith('rebuild-availability-cache');
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'rebuild-availability-cache',
      { expertProfileId: EXPERT_ID },
      { jobId: `availability-${EXPERT_ID}`, removeOnComplete: true, removeOnFail: false }
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs and swallows enqueue failures (never throws)', async () => {
    const log = makeLog();
    mockQueueAdd.mockRejectedValueOnce(new Error('redis down'));

    await expect(enqueueAvailabilityCacheRebuild(EXPERT_ID, log)).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(
      { expertProfileId: EXPERT_ID, error: 'redis down' },
      'Failed to enqueue availability cache rebuild job'
    );
  });
});
