/**
 * BAL-473 (§6.4) — `recording-cleanup-source`. Deletes the Daily source AFTER Mux has
 * confirmed the asset is `ready` (D4). ONE job per `meeting_recordings` row.
 */
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { meetingRecordingsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { sanitizedErrorMessage } from '../lib/sanitize-error.js';
import { deleteRecording } from '../services/daily/recordings.js';
import { DailyApiError } from '../services/daily/errors.js';

const log = createLogger('recording-cleanup-source');

export const RECORDING_CLEANUP_SOURCE_QUEUE = 'recording-cleanup-source';

const ATTEMPTS = 3;
const BACKOFF_DELAY_MS = 30_000;

export interface RecordingCleanupSourceJobData {
  recordingId: string;
}

export interface EnqueueRecordingCleanupSourceInput {
  recordingId: string;
}

/** jobId keyed on the row — one `ready` per row, one write. */
export async function enqueueRecordingCleanupSource(
  input: EnqueueRecordingCleanupSourceInput
): Promise<void> {
  await getQueue(RECORDING_CLEANUP_SOURCE_QUEUE).add(
    'cleanup',
    { recordingId: input.recordingId } satisfies RecordingCleanupSourceJobData,
    {
      jobId: `recording-cleanup-source--${input.recordingId}`,
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
    }
  );
}

function isUnrecoverableDailyError(error: unknown): boolean {
  return error instanceof DailyApiError && error.status !== 429 && error.status < 500;
}

async function handleCleanup(job: Job<RecordingCleanupSourceJobData>): Promise<void> {
  const { recordingId } = job.data;

  const row = await meetingRecordingsRepository.findById(recordingId);
  if (row === undefined) {
    log.info({ recordingId }, 'recording-cleanup-source: no live row — no-op');
    return;
  }
  if (row.sourceDeletedAt !== null) {
    log.info({ recordingId }, 'recording-cleanup-source: already stamped — no-op');
    return;
  }
  // ⚠⚠ D4, BELT TO THE REPOSITORY'S BRACES. The Daily source is the ONLY thing a failed ingest
  // can retry from; deleting it before `ready` would make a recoverable failure permanent.
  if (row.status !== 'ready') {
    log.error(
      { recordingId, status: row.status },
      'recording-cleanup-source: refused — row is not ready (D4)'
    );
    return;
  }
  if (row.dailyRecordingId === null) {
    log.error({ recordingId }, 'recording-cleanup-source: ready row has no daily_recording_id');
    return;
  }

  try {
    const outcome = await deleteRecording(row.dailyRecordingId);
    // ⚠ FIX ROUND 1 (F14) — BRANCH ON THE CAS RETURN, matching every other CAS call site in
    // this PR (`markStarted`, `markSourceReady`, `markReady`, `markFailed` all log at `info`
    // on `undefined`). `undefined` here means a concurrent/earlier attempt already stamped
    // `source_deleted_at` — a successful no-op, not a fact to claim unconditionally.
    const updated = await meetingRecordingsRepository.markSourceDeleted({
      id: row.id,
      at: new Date(),
    });
    if (updated === undefined) {
      log.info(
        { recordingId, outcome },
        'recording-cleanup-source: Daily source deleted, but the CAS was a no-op (replay)'
      );
      return;
    }
    log.info({ recordingId, outcome }, 'recording-cleanup-source: Daily source cleaned up');
  } catch (error) {
    if (isUnrecoverableDailyError(error)) {
      // ⚠ FIX ROUND 1 (F4) — sanitized, matching `recording-ingest.ts`. `DailyApiError.message`
      // is a fixed template today (never echoes a body), but this keeps the two recording jobs'
      // vendor-error handling symmetric rather than relying on that staying true.
      throw new UnrecoverableError(sanitizedErrorMessage(error));
    }
    throw error;
  }
}

export function startRecordingCleanupSourceWorker(): Worker<RecordingCleanupSourceJobData> {
  const worker = new Worker<RecordingCleanupSourceJobData>(
    RECORDING_CLEANUP_SOURCE_QUEUE,
    async (job) => handleCleanup(job),
    { connection: createRedisConnection(), concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    if (!job) {
      return;
    }
    const attempts = job.opts.attempts ?? ATTEMPTS;
    const terminal = err instanceof UnrecoverableError || job.attemptsMade >= attempts;
    if (!terminal) {
      return;
    }
    // ⚠ LOG ONLY. NEVER STAMPS `failed` — the segment is `ready` and playable; a retained
    // Daily source is a storage-cost issue, not a recording failure. (The repository's CAS
    // would refuse a `markFailed` on a `ready` row anyway.)
    log.error(
      { recordingId: job.data.recordingId, error: sanitizedErrorMessage(err) },
      'recording-cleanup-source: exhausted retries — Daily source retained, playable recording unaffected'
    );
  });

  return worker;
}
