import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addBulk: vi.fn(),
  findById: vi.fn(),
  publishCreated: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  workerOn: vi.fn(),
  workerCtor: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mocks.info, warn: mocks.warn, error: vi.fn() }),
}));
vi.mock('bullmq', () => ({
  Worker: class {
    constructor(...args: unknown[]) {
      mocks.workerCtor(...args);
    }
    on = mocks.workerOn;
  },
}));
vi.mock('@balo/db', () => ({ meetingRingsRepository: { findById: mocks.findById } }));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({ conn: true }) }));
vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  getQueue: () => ({ addBulk: mocks.addBulk }),
}));
vi.mock('../notifications/channels/in-app-push.js', () => ({
  publishNotificationCreated: mocks.publishCreated,
}));

import type { Job } from 'bullmq';
import { buildJobId } from '../lib/queue.js';
import {
  CALL_NOW_RING_REPING_EARLY_DELAYS_MS,
  CALL_NOW_RING_REPING_INTERVAL_MS,
  CALL_NOW_RING_REPING_QUEUE,
  enqueueCallNowRingRepings,
  handleCallNowRingReping,
  ringRepingDelaysMs,
  startCallNowRingRepingWorker,
  type CallNowRingRepingJobData,
} from './call-now-ring-reping.js';

const RING_ID = '88888888-8888-4888-8888-888888888888';
const CALLEE_ID = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-11-16T10:00:00.000Z');

function job(): Job<CallNowRingRepingJobData> {
  return { data: { ringId: RING_ID } } as Job<CallNowRingRepingJobData>;
}

function ring(overrides: Partial<{ status: string; expiresAt: Date }> = {}): unknown {
  return {
    id: RING_ID,
    calleeUserId: CALLEE_ID,
    status: 'ringing',
    createdAt: new Date(NOW.getTime() - 13_000),
    expiresAt: new Date(NOW.getTime() + 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.addBulk.mockResolvedValue(undefined);
  mocks.publishCreated.mockResolvedValue(undefined);
});

describe('ringRepingDelaysMs', () => {
  it('pings at 3 s and 6 s, then once per 10 s interval, strictly before expires_at', () => {
    expect(CALL_NOW_RING_REPING_EARLY_DELAYS_MS).toEqual([3_000, 6_000]);
    expect(CALL_NOW_RING_REPING_INTERVAL_MS).toBe(10_000);
    expect(ringRepingDelaysMs(new Date(NOW.getTime() + 45_000), NOW)).toEqual([
      3_000, 6_000, 10_000, 20_000, 30_000, 40_000,
    ]);
  });

  it('never schedules a ping on the expiry instant itself', () => {
    expect(ringRepingDelaysMs(new Date(NOW.getTime() + 30_000), NOW)).toEqual([
      3_000, 6_000, 10_000, 20_000,
    ]);
    expect(ringRepingDelaysMs(new Date(NOW.getTime() + 6_000), NOW)).toEqual([3_000]);
  });

  it('is empty for a ring of 3 s or less, or one already expired', () => {
    expect(ringRepingDelaysMs(new Date(NOW.getTime() + 3_000), NOW)).toEqual([]);
    expect(ringRepingDelaysMs(new Date(NOW.getTime() - 1), NOW)).toEqual([]);
  });

  it('covers a two-minute ring with thirteen re-pings', () => {
    expect(ringRepingDelaysMs(new Date(NOW.getTime() + 117_000), NOW)).toHaveLength(13);
  });
});

describe('enqueueCallNowRingRepings', () => {
  it('adds one delayed, single-attempt `reping` job per tick, each with its own colon-free id', async () => {
    await enqueueCallNowRingRepings(RING_ID, new Date(NOW.getTime() + 12_000), NOW);

    expect(mocks.addBulk).toHaveBeenCalledTimes(1);
    expect(mocks.addBulk).toHaveBeenCalledWith(
      [3_000, 6_000, 10_000].map((delay, index) => ({
        name: 'reping',
        data: { ringId: RING_ID },
        opts: {
          jobId: buildJobId('call-now-ring-reping', RING_ID, String(index + 1)),
          delay,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      }))
    );
  });

  it('adds nothing when the ring is too short to need a re-ping', async () => {
    await enqueueCallNowRingRepings(RING_ID, new Date(NOW.getTime() + 3_000), NOW);

    expect(mocks.addBulk).not.toHaveBeenCalled();
  });

  it('propagates an enqueue failure so the caller can log it', async () => {
    mocks.addBulk.mockRejectedValue(new Error('redis down'));

    await expect(
      enqueueCallNowRingRepings(RING_ID, new Date(NOW.getTime() + 60_000), NOW)
    ).rejects.toThrow('redis down');
  });
});

describe('handleCallNowRingReping', () => {
  it('pings the callee recorded on the ring while it is still ringing', async () => {
    mocks.findById.mockResolvedValue(ring());

    await handleCallNowRingReping(job(), NOW);

    expect(mocks.findById).toHaveBeenCalledWith(RING_ID);
    expect(mocks.publishCreated).toHaveBeenCalledTimes(1);
    expect(mocks.publishCreated).toHaveBeenCalledWith(CALLEE_ID);
    expect(mocks.info).toHaveBeenCalledWith(
      { ringId: RING_ID, ringAgeMs: 13_000 },
      'call-now-ring-reping: re-ping sent'
    );
  });

  it.each(['connected', 'unanswered', 'declined', 'stopped'])(
    'does not ping once the ring is %s',
    async (status) => {
      mocks.findById.mockResolvedValue(ring({ status }));

      await handleCallNowRingReping(job(), NOW);

      expect(mocks.publishCreated).not.toHaveBeenCalled();
      expect(mocks.info).not.toHaveBeenCalled();
    }
  );

  it('does not ping a ring still marked ringing but past expires_at', async () => {
    mocks.findById.mockResolvedValue(ring({ expiresAt: NOW }));

    await handleCallNowRingReping(job(), NOW);

    expect(mocks.publishCreated).not.toHaveBeenCalled();
  });

  it('does not ping a ring that no longer exists', async () => {
    mocks.findById.mockResolvedValue(undefined);

    await handleCallNowRingReping(job(), NOW);

    expect(mocks.publishCreated).not.toHaveBeenCalled();
  });
});

describe('startCallNowRingRepingWorker', () => {
  it('runs the handler on the re-ping queue and warns when a job fails', async () => {
    startCallNowRingRepingWorker();

    const [queueName, processor] = mocks.workerCtor.mock.calls[0] as [
      string,
      (job: Job<CallNowRingRepingJobData>) => Promise<void>,
    ];
    expect(queueName).toBe(CALL_NOW_RING_REPING_QUEUE);

    mocks.findById.mockResolvedValue(ring({ expiresAt: new Date(Date.now() + 60_000) }));
    await processor(job());
    expect(mocks.publishCreated).toHaveBeenCalledWith(CALLEE_ID);

    const failed = mocks.workerOn.mock.calls.find(([event]) => event === 'failed');
    const onFailed = failed?.[1] as (job: Job<CallNowRingRepingJobData>, err: Error) => void;
    onFailed(job(), new Error('db down'));
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ringId: RING_ID, error: 'db down' }),
      expect.stringContaining('re-ping failed')
    );
  });
});
