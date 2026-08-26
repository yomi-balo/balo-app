import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DailyApiError } from '../services/daily/errors.js';

const queueAdd = vi.hoisted(() => vi.fn());
const findById = vi.hoisted(() => vi.fn());
const markSourceDeleted = vi.hoisted(() => vi.fn());
const markFailed = vi.hoisted(() => vi.fn());
const deleteRecording = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());

const wired = vi.hoisted(
  () =>
    ({ processor: undefined, failedHandler: undefined }) as {
      processor?: (job: unknown) => Promise<void>;
      failedHandler?: (job: unknown, err: Error) => void;
    }
);

const MockUnrecoverableError = vi.hoisted(
  () =>
    class extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'UnrecoverableError';
      }
    }
);

const WorkerMock = vi.hoisted(() =>
  vi.fn(function (_queue: string, processor: (job: unknown) => Promise<void>) {
    wired.processor = processor;
    return {
      on: (event: string, handler: (job: unknown, err: Error) => void) => {
        if (event === 'failed') {
          wired.failedHandler = handler;
        }
      },
    };
  })
);

vi.mock('../lib/queue.js', () => ({ getQueue: () => ({ add: queueAdd }) }));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn(() => ({ conn: true })) }));
vi.mock('bullmq', () => ({ Worker: WorkerMock, UnrecoverableError: MockUnrecoverableError }));
vi.mock('@balo/db', () => ({
  meetingRecordingsRepository: { findById, markSourceDeleted, markFailed },
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ error: logError, info: logInfo }),
}));
vi.mock('../services/daily/recordings.js', () => ({ deleteRecording }));

import {
  enqueueRecordingCleanupSource,
  startRecordingCleanupSourceWorker,
  RECORDING_CLEANUP_SOURCE_QUEUE,
} from './recording-cleanup-source.js';

const RECORDING_ID = 'rec-1';
const DAILY_RECORDING_ID = 'daily-rec-1';

function readyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RECORDING_ID,
    status: 'ready',
    dailyRecordingId: DAILY_RECORDING_ID,
    sourceDeletedAt: null,
    ...overrides,
  };
}

describe('recording-cleanup-source job — enqueue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues with jobId keyed on the recordingId', async () => {
    await enqueueRecordingCleanupSource({ recordingId: RECORDING_ID });

    expect(queueAdd).toHaveBeenCalledWith(
      'cleanup',
      { recordingId: RECORDING_ID },
      {
        jobId: `recording-cleanup-source--${RECORDING_ID}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      }
    );
  });

  it('exposes the queue name', () => {
    expect(RECORDING_CLEANUP_SOURCE_QUEUE).toBe('recording-cleanup-source');
  });
});

describe('recording-cleanup-source job — handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startRecordingCleanupSourceWorker();
  });

  async function run(recordingId = RECORDING_ID): Promise<void> {
    await wired.processor?.({ data: { recordingId } });
  }

  it('no-ops when the row is absent', async () => {
    findById.mockResolvedValue(undefined);
    await run();
    expect(deleteRecording).not.toHaveBeenCalled();
  });

  it('already-stamped ⇒ no vendor call', async () => {
    findById.mockResolvedValue(readyRow({ sourceDeletedAt: new Date() }));
    await run();
    expect(deleteRecording).not.toHaveBeenCalled();
  });

  it('⚠⚠ D4 — refuses a non-ready row and logs at error, no vendor call', async () => {
    findById.mockResolvedValue(readyRow({ status: 'ingesting' }));
    await run();
    expect(deleteRecording).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
  });

  it('refuses a ready row with no daily_recording_id', async () => {
    findById.mockResolvedValue(readyRow({ dailyRecordingId: null }));
    await run();
    expect(deleteRecording).not.toHaveBeenCalled();
  });

  it('deletes the source and stamps source_deleted_at on success', async () => {
    findById.mockResolvedValue(readyRow());
    deleteRecording.mockResolvedValue('deleted');

    await run();

    expect(deleteRecording).toHaveBeenCalledWith(DAILY_RECORDING_ID);
    expect(markSourceDeleted).toHaveBeenCalledWith(expect.objectContaining({ id: RECORDING_ID }));
  });

  it('⚠ a 404 (already_gone) STILL stamps source_deleted_at — the deleteRoom precedent', async () => {
    findById.mockResolvedValue(readyRow());
    deleteRecording.mockResolvedValue('already_gone');

    await run();

    expect(markSourceDeleted).toHaveBeenCalledWith(expect.objectContaining({ id: RECORDING_ID }));
  });

  it('a non-429 4xx becomes UnrecoverableError', async () => {
    findById.mockResolvedValue(readyRow());
    deleteRecording.mockRejectedValue(new DailyApiError('DELETE', '/x', 400, 'bad'));

    await expect(run()).rejects.toBeInstanceOf(MockUnrecoverableError);
    expect(markSourceDeleted).not.toHaveBeenCalled();
  });

  it('rethrows a 500 (retryable)', async () => {
    findById.mockResolvedValue(readyRow());
    deleteRecording.mockRejectedValue(new DailyApiError('DELETE', '/x', 500, 'boom'));

    await expect(run()).rejects.toBeInstanceOf(DailyApiError);
  });
});

describe('recording-cleanup-source job — worker.on("failed")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startRecordingCleanupSourceWorker();
  });

  it('is a no-op when there is no job', () => {
    expect(() => wired.failedHandler?.(null, new Error('x'))).not.toThrow();
  });

  it('waits for BullMQ to retry while attempts remain', () => {
    wired.failedHandler?.(
      { data: { recordingId: RECORDING_ID }, opts: { attempts: 3 }, attemptsMade: 1 },
      new Error('boom')
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it('⚠ terminal failure logs only — NEVER stamps `failed` (the segment is ready and playable)', () => {
    wired.failedHandler?.(
      { data: { recordingId: RECORDING_ID }, opts: { attempts: 3 }, attemptsMade: 3 },
      new Error('boom')
    );
    expect(logError).toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });
});
