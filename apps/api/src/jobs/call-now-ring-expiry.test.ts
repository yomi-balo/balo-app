import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  endRing: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  workerOn: vi.fn(),
  workerCtor: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mocks.info, warn: vi.fn(), error: mocks.error }),
}));
vi.mock('bullmq', () => ({
  Worker: class {
    constructor(...args: unknown[]) {
      mocks.workerCtor(...args);
    }
    on = mocks.workerOn;
  },
}));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({ conn: true }) }));
vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  getQueue: () => ({ add: mocks.add }),
}));
vi.mock('../services/call-now/end-ring.js', () => ({ endRing: mocks.endRing }));

import type { Job } from 'bullmq';
import {
  CALL_NOW_RING_EXPIRY_MARGIN_MS,
  CALL_NOW_RING_EXPIRY_QUEUE,
  enqueueCallNowRingExpiry,
  handleCallNowRingExpiry,
  RingNotYetDueError,
  startCallNowRingExpiryWorker,
  type CallNowRingExpiryJobData,
} from './call-now-ring-expiry.js';

const RING_ID = '88888888-8888-4888-8888-888888888888';
const NOW = new Date('2026-11-16T10:00:00.000Z');

function job(): Job<CallNowRingExpiryJobData> {
  return { data: { ringId: RING_ID } } as Job<CallNowRingExpiryJobData>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.add.mockResolvedValue(undefined);
});

describe('enqueueCallNowRingExpiry', () => {
  it('adds one delayed `expire` job keyed on the ring, landing 250 ms after expires_at', async () => {
    await enqueueCallNowRingExpiry(RING_ID, new Date(NOW.getTime() + 45_000), NOW);

    expect(mocks.add).toHaveBeenCalledWith(
      'expire',
      { ringId: RING_ID },
      expect.objectContaining({
        jobId: `call-now-ring-expiry--${RING_ID}`,
        delay: 45_000 + CALL_NOW_RING_EXPIRY_MARGIN_MS,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: true,
      })
    );
  });

  it('never schedules a negative delay for an already-past expiry', async () => {
    await enqueueCallNowRingExpiry(RING_ID, new Date(NOW.getTime() - 5_000), NOW);

    expect(mocks.add.mock.calls[0]?.[2]).toMatchObject({ delay: CALL_NOW_RING_EXPIRY_MARGIN_MS });
  });

  it('uses a colon-free job id', async () => {
    await enqueueCallNowRingExpiry(RING_ID, NOW, NOW);

    expect((mocks.add.mock.calls[0]?.[2] as { jobId: string }).jobId).not.toContain(':');
  });

  it('lets an enqueue failure reach the caller (start-call warns and carries on)', async () => {
    mocks.add.mockRejectedValue(new Error('redis down'));

    await expect(enqueueCallNowRingExpiry(RING_ID, NOW, NOW)).rejects.toThrow('redis down');
  });
});

describe('handleCallNowRingExpiry', () => {
  it('delegates to endRing(unanswered) with a null actor', async () => {
    mocks.endRing.mockResolvedValue({ ended: true, status: 'unanswered' });

    await handleCallNowRingExpiry(job());

    expect(mocks.endRing).toHaveBeenCalledWith({
      ringId: RING_ID,
      to: 'unanswered',
      actorUserId: null,
      now: expect.any(Date),
    });
  });

  it('a no-op outcome (already connected / ended) is success, logged at info', async () => {
    mocks.endRing.mockResolvedValue({ ended: false, status: 'connected' });

    await expect(handleCallNowRingExpiry(job())).resolves.toBeUndefined();
    expect(mocks.info).toHaveBeenCalledWith(
      { ringId: RING_ID, status: 'connected' },
      expect.stringContaining('no-op')
    );
  });

  it('⚠ fired early with the ring still `ringing` (not yet due): throws so the backoff retries', async () => {
    mocks.endRing.mockResolvedValue({ ended: false, status: 'ringing' });

    await expect(handleCallNowRingExpiry(job())).rejects.toBeInstanceOf(RingNotYetDueError);
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('an unknown ring (status null) is a no-op, not a retry', async () => {
    mocks.endRing.mockResolvedValue({ ended: false, status: null });

    await expect(handleCallNowRingExpiry(job())).resolves.toBeUndefined();
  });

  it('lets a real failure throw so BullMQ retries', async () => {
    mocks.endRing.mockRejectedValue(new Error('db down'));

    await expect(handleCallNowRingExpiry(job())).rejects.toThrow('db down');
  });
});

describe('startCallNowRingExpiryWorker', () => {
  it('builds a worker on the call-now-ring-expiry queue', () => {
    startCallNowRingExpiryWorker();

    expect(mocks.workerCtor).toHaveBeenCalledWith(
      CALL_NOW_RING_EXPIRY_QUEUE,
      expect.any(Function),
      expect.objectContaining({ concurrency: 5 })
    );
  });

  it('logs at error only once the retries are exhausted', () => {
    startCallNowRingExpiryWorker();
    const failed = mocks.workerOn.mock.calls.find(([event]) => event === 'failed')?.[1] as (
      job: unknown,
      err: Error
    ) => void;

    failed(undefined, new Error('x'));
    failed({ data: { ringId: RING_ID }, opts: { attempts: 3 }, attemptsMade: 1 }, new Error('x'));
    expect(mocks.error).not.toHaveBeenCalled();

    failed(
      { data: { ringId: RING_ID }, opts: { attempts: 3 }, attemptsMade: 3 },
      new Error('boom')
    );
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ ringId: RING_ID, error: 'boom' }),
      expect.stringContaining('exhausted retries')
    );
  });

  it('runs the handler for a queued job', async () => {
    mocks.endRing.mockResolvedValue({ ended: true });
    startCallNowRingExpiryWorker();
    const processor = mocks.workerCtor.mock.calls[0]?.[1] as (
      j: Job<CallNowRingExpiryJobData>
    ) => Promise<void>;

    await processor(job());

    expect(mocks.endRing).toHaveBeenCalled();
  });
});
