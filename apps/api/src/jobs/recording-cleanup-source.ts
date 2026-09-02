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
  /**
   * ⚠⚠ FIX ROUND 2 — optional. Omitted by the Mux-triggered first enqueue
   * (`routes/mux/webhook.ts`), which gets the bare, ROW-keyed jobId — correct there because
   * `video.asset.ready` fires once per row. Supplied by `routes/daily/webhook.ts`'s §7.4
   * re-drive as the Daily batch job id, which gives that WRITE its own, disjoint jobId. See
   * {@link recordingCleanupSourceJobId}.
   */
  dedupeToken?: string;
}

/**
 * FIX ROUND 1 (M5) — the ONE definition of this queue's jobId scheme. Both `routes/mux/webhook.ts`
 * and `routes/daily/webhook.ts` go through `enqueueRecordingCleanupSource`, which calls this;
 * neither call site hand-rolls the template.
 *
 * ⚠⚠ FIX ROUND 2 — TWO SHAPES, BOTH KEYED ON A WRITE, NEVER ON A TARGET STATE (the standing
 * rule stated in `recording-capture.ts`'s module docblock and honoured across this codebase).
 * `recordingId` alone identifies the write that first learns the Daily source is safe to
 * delete — Mux's `video.asset.ready`, which fires at most once per row — so the bare form is
 * correct there. `routes/daily/webhook.ts`'s §7.4 re-drive is a SEPARATE, LATER write (the
 * Daily batch transcription job reaching a terminal state) and must NOT collide with the first
 * one: BullMQ dedups a jobId against a job in ANY state, including `active`. Fix round 1 made
 * the re-add unconditional, but under the SAME bare jobId that was still not enough — if the
 * Mux-triggered job was active (withheld, mid-§7.4-wait) at the moment this fired, the
 * unconditional re-add was silently DROPPED by that dedup, and nothing ever re-enqueued the
 * withheld job once it completed as a stale no-op (Mux's `ready` fires once). Passing
 * `dedupeToken` appends it, so the re-drive's jobId never collides with the bare, row-keyed one.
 *
 * A duplicate re-drive under this jobId (e.g. a replayed `batch-processor.job-finished`
 * delivery, which carries the same batch job id and therefore the same jobId) is a clean no-op
 * either way: `handleCleanup` below short-circuits on `sourceDeletedAt !== null` before it ever
 * touches Daily.
 */
export function recordingCleanupSourceJobId(recordingId: string, dedupeToken?: string): string {
  return dedupeToken === undefined
    ? `recording-cleanup-source--${recordingId}`
    : `recording-cleanup-source--${recordingId}--${dedupeToken}`;
}

/**
 * jobId keyed on the row by default (the Mux-triggered first enqueue); keyed on the row PLUS
 * `dedupeToken` when the caller supplies one (the §7.4 re-drive). See
 * {@link recordingCleanupSourceJobId}.
 */
export async function enqueueRecordingCleanupSource(
  input: EnqueueRecordingCleanupSourceInput
): Promise<void> {
  await getQueue(RECORDING_CLEANUP_SOURCE_QUEUE).add(
    'cleanup',
    { recordingId: input.recordingId } satisfies RecordingCleanupSourceJobData,
    {
      jobId: recordingCleanupSourceJobId(input.recordingId, input.dedupeToken),
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
  // ⚠⚠ BAL-483 — WITHHELD WHILE A BATCH TRANSCRIPTION JOB IS STILL READING THIS SOURCE.
  // `POST /batch-processor` DOWNLOADS the Daily recording; deleting it mid-job produces
  // Daily's documented `"Failed to download: 403 Forbidden"` (`batch-processor.error`) and
  // permanently loses this segment's transcript. Mux transcode and Deepgram batch race with
  // no ordering guarantee, so this cannot be left to luck.
  //
  // ⚠ IT IS BOUNDED, NOT OPEN-ENDED: BOTH batch terminal arms re-enqueue this job
  // (`routes/daily/webhook.ts`, `handleTranscriptCapturePostCommit`), so the wait ends the
  // moment the vendor answers at all.
  //
  // ⚠ THE RESIDUAL, STATED NOT FIXED: a batch job that NEVER reaches a terminal webhook
  // leaks the Daily source. It costs STORAGE, not correctness, and it is queryable:
  //   SELECT id, meeting_id, transcript_job_submitted_at FROM meeting_recordings
  //    WHERE transcript_job_submitted_at IS NOT NULL AND transcript_job_finished_at IS NULL
  //      AND source_deleted_at IS NULL AND status = 'ready' AND deleted_at IS NULL;
  // The alternative — delete anyway — costs the recap, which is the whole feature.
  //
  // ⚠⚠ A SEPARATE RESIDUAL THIS GATE DOES NOT COVER: if the SUBMIT POST to Daily succeeded but
  // `markTranscriptJobSubmitted` then failed to stamp the row, `transcript_job_submitted_at`
  // stays NULL, so this gate is FALSE and cleanup proceeds — deleting the Daily source out from
  // under a batch job that is genuinely in flight. That is R2's residual reached through a
  // different door; it costs that segment's transcript, not correctness.
  //
  // ⚠ FIX ROUND 1 (M9) — A THIRD DOOR, NOT REACHABLE TODAY BUT UNGUARDED THE MOMENT ONE SHIPS:
  // `routes/daily/webhook.ts`'s batch-processor arm resolves the recording row, then does
  // `meetingsRepository.findById(recording.meetingId)` and bails to `null` (no effect, no CAS)
  // when the meeting is gone. There is NO delete-meeting route in this codebase today, so that
  // branch is unreachable in practice — but if one ships, a meeting deleted while a batch job is
  // in flight would leave `transcript_job_submitted_at` stamped and `transcript_job_finished_at`
  // permanently NULL (the terminal webhook can never apply), and THIS gate would withhold
  // forever — the opposite of the deleting user's intent, keeping the vendor copy alive.
  // Deliberately unbounded here (see the plan's R2/R3/R4 "stated not fixed" precedent) rather
  // than adding an age cutoff pre-emptively for a path that cannot fire yet.
  if (row.transcriptJobSubmittedAt !== null && row.transcriptJobFinishedAt === null) {
    log.info(
      { recordingId },
      'recording-cleanup-source: withheld — a Daily batch transcription job is still reading this source (BAL-483)'
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
