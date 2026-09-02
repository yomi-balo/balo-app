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
  recordingCleanupSourceJobId,
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

  it('⚠ FIX ROUND 1 (M5) — recordingCleanupSourceJobId is the ONE definition of this jobId scheme', () => {
    expect(recordingCleanupSourceJobId(RECORDING_ID)).toBe(
      `recording-cleanup-source--${RECORDING_ID}`
    );
  });

  it('⚠⚠ FIX ROUND 2 — recordingCleanupSourceJobId pins BOTH shapes: bare (row-keyed) and with a dedupeToken (write-keyed)', () => {
    expect(recordingCleanupSourceJobId(RECORDING_ID)).toBe(
      `recording-cleanup-source--${RECORDING_ID}`
    );
    expect(recordingCleanupSourceJobId(RECORDING_ID, 'batch-job-1')).toBe(
      `recording-cleanup-source--${RECORDING_ID}--batch-job-1`
    );
    // ⚠ The two shapes must be genuinely DISJOINT — this is what stops the §7.4 re-drive from
    // colliding with the Mux-triggered enqueue's jobId (fix round 2's fix).
    expect(recordingCleanupSourceJobId(RECORDING_ID, 'batch-job-1')).not.toBe(
      recordingCleanupSourceJobId(RECORDING_ID)
    );
  });

  it('⚠⚠ FIX ROUND 2 — enqueueRecordingCleanupSource passes dedupeToken through to the jobId', async () => {
    await enqueueRecordingCleanupSource({ recordingId: RECORDING_ID, dedupeToken: 'batch-job-1' });

    expect(queueAdd).toHaveBeenCalledWith(
      'cleanup',
      { recordingId: RECORDING_ID },
      {
        jobId: `recording-cleanup-source--${RECORDING_ID}--batch-job-1`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      }
    );
  });

  it('⚠⚠ FIX ROUND 2 — the write-keyed re-drive still enqueues even while a job under the ROW-keyed jobId is ACTIVE, because the two jobIds are genuinely distinct', async () => {
    // Simulate BullMQ's real dedup semantic: `Queue.add()` silently no-ops (does not create a
    // new job) when a jobId already names a job in ANY state, including `active`. This is the
    // exact mechanism that made fix round 1's remove-then-add recipe insufficient — `remove()`
    // rejecting on an active job left the bare, row-keyed jobId "occupied", and an unconditional
    // re-add under that SAME jobId was silently dropped (see the docblock at the `webhook.ts`
    // §7.4 call site).
    const jobsInFlight = new Set<string>([recordingCleanupSourceJobId(RECORDING_ID)]); // Mux-triggered job, ACTIVE
    queueAdd.mockImplementation(async (_name: string, _data: unknown, opts: { jobId: string }) => {
      if (jobsInFlight.has(opts.jobId)) {
        return undefined; // BullMQ dedup: silently dropped, no new job created
      }
      jobsInFlight.add(opts.jobId);
      return { id: opts.jobId };
    });

    // The §7.4 re-drive — a DIFFERENT write (the batch job reaching a terminal state), keyed
    // with its own dedupeToken.
    await enqueueRecordingCleanupSource({ recordingId: RECORDING_ID, dedupeToken: 'batch-job-1' });

    const reDriveJobId = recordingCleanupSourceJobId(RECORDING_ID, 'batch-job-1');
    expect(queueAdd).toHaveBeenCalledWith(
      'cleanup',
      { recordingId: RECORDING_ID },
      expect.objectContaining({ jobId: reDriveJobId })
    );
    // Proof the two jobIds are genuinely distinct: the re-drive's jobId was NOT already in
    // `jobsInFlight` (the Mux-triggered job's bare jobId), so the fake dedup let it through
    // rather than silently swallowing it.
    expect(jobsInFlight.has(reDriveJobId)).toBe(true);
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

  // ── BAL-483 §7.4 — the withhold gate ───────────────────────────────────────────────────

  it('⚠⚠ BAL-483 — withheld while a batch transcription job is still reading this source: no DELETE, logged', async () => {
    findById.mockResolvedValue(
      readyRow({ transcriptJobSubmittedAt: new Date(), transcriptJobFinishedAt: null })
    );

    await run();

    expect(deleteRecording).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: RECORDING_ID }),
      expect.stringContaining('withheld')
    );
  });

  it('BAL-483 — proceeds once transcriptJobFinishedAt is set (the batch job is terminal)', async () => {
    findById.mockResolvedValue(
      readyRow({ transcriptJobSubmittedAt: new Date(), transcriptJobFinishedAt: new Date() })
    );
    deleteRecording.mockResolvedValue('deleted');

    await run();

    expect(deleteRecording).toHaveBeenCalledWith(DAILY_RECORDING_ID);
  });

  it('BAL-483 — proceeds when transcriptJobSubmittedAt is null (a segment never submitted for transcription)', async () => {
    findById.mockResolvedValue(
      readyRow({ transcriptJobSubmittedAt: null, transcriptJobFinishedAt: null })
    );
    deleteRecording.mockResolvedValue('deleted');

    await run();

    expect(deleteRecording).toHaveBeenCalledWith(DAILY_RECORDING_ID);
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
