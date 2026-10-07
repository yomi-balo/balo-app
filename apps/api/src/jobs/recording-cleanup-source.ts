/**
 * BAL-473 (§6.4) — `recording-cleanup-source`. Deletes the Daily source AFTER Mux has
 * confirmed the asset is `ready` (D4). ONE job per `meeting_recordings` row.
 */
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { meetingRecordingsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { buildJobId, getQueue } from '../lib/queue.js';
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
  /**
   * BAL-520 — OPT-IN BullMQ `delay`, supplied ONLY by the Mux `video.asset.ready` call site with
   * `TRANSCRIPT_SUBMIT_RETRY_BUDGET_MS` (see DOOR 3 in `handleCleanup`). NEVER inferred from
   * `dedupeToken === undefined`: the §7.4 re-drive omits it and stays immediate.
   */
  delayMs?: number;
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
 *
 * ⚠⚠ BAL-531 FIX ROUND (F5) — DELIBERATELY LEFT VARIABLE-ARITY, UNLIKE
 * `calendar-subscription-reconcile.ts`'s identical-shaped helper. Considered and rejected making
 * this always-3-part (`buildJobId('recording-cleanup-source', recordingId, dedupeToken ??
 * 'primary')`) to close the same theoretical cross-arity collision `lib/queue.ts`'s docblock
 * documents. Decision: NOT worth it here, for two independent reasons —
 *  1. UNLIKE that call site, this queue has NO per-call `removeOnComplete`/`removeOnFail`
 *     override, so it inherits `lib/queue.ts`'s shared, NON-ZERO defaults
 *     (`{ count: 100 }` / `{ count: 500 }`). Rewriting the bare form's id would therefore open a
 *     real (if harmless — see the no-op above) duplicate-delivery window on EVERY recording, not
 *     a zero-cost change the way the reconcile queue's rewrite was.
 *  2. The collision this would close cannot occur here in the first place: `recordingId` is
 *     `meeting_recordings.id`, a Postgres `uuid` column — a real UUID's fixed hyphen positions
 *     mean it can never contain the `--` sequence the two-part/three-part join is keyed on, so
 *     the bare form's escaped output can never equal a genuinely different (recordingId,
 *     dedupeToken) pair's 3-part output. There is no live risk to trade the churn for.
 */
export function recordingCleanupSourceJobId(recordingId: string, dedupeToken?: string): string {
  return dedupeToken === undefined
    ? buildJobId('recording-cleanup-source', recordingId)
    : buildJobId('recording-cleanup-source', recordingId, dedupeToken);
}

/**
 * jobId keyed on the row by default (the Mux-triggered first enqueue); keyed on the row PLUS
 * `dedupeToken` when the caller supplies one (the §7.4 re-drive). See
 * {@link recordingCleanupSourceJobId}.
 *
 * `delay` does not change dedup — a delayed job still occupies its jobId; the re-drive's
 * write-keyed jobId is disjoint.
 */
export async function enqueueRecordingCleanupSource(
  input: EnqueueRecordingCleanupSourceInput
): Promise<void> {
  if (input.delayMs !== undefined && (!Number.isFinite(input.delayMs) || input.delayMs < 0)) {
    throw new Error(
      'enqueueRecordingCleanupSource `delayMs` must be a finite, non-negative number'
    );
  }
  await getQueue(RECORDING_CLEANUP_SOURCE_QUEUE).add(
    'cleanup',
    { recordingId: input.recordingId } satisfies RecordingCleanupSourceJobData,
    {
      jobId: recordingCleanupSourceJobId(input.recordingId, input.dedupeToken),
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
      ...(input.delayMs === undefined ? {} : { delay: input.delayMs }),
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
  // ⚠ DOOR 1 — THE RESIDUAL, STATED NOT FIXED: a batch job that NEVER reaches a terminal
  // webhook leaks the Daily source. It costs STORAGE, not correctness, and it is queryable:
  //   SELECT id, meeting_id, transcript_job_submitted_at FROM meeting_recordings
  //    WHERE transcript_job_submitted_at IS NOT NULL AND transcript_job_finished_at IS NULL
  //      AND source_deleted_at IS NULL AND status = 'ready' AND deleted_at IS NULL;
  // The alternative — delete anyway — costs the recap, which is the whole feature.
  //
  // ⚠⚠ DOOR 2 — A SEPARATE RESIDUAL THIS GATE DOES NOT COVER: if the SUBMIT POST to Daily
  // succeeded but `markTranscriptJobSubmitted` then failed to stamp the row,
  // `transcript_job_submitted_at` stays NULL, so this gate is FALSE and cleanup proceeds —
  // deleting the Daily source out from under a batch job that is genuinely in flight. That is
  // R2's residual reached through a different door; it costs that segment's transcript, not
  // correctness. Submit HAS RUN here — the stamp is what failed.
  //
  // ⚠⚠ DOOR 3, EASY TO CONFLATE WITH DOOR 2 BUT THE TIMING IS THE OPPOSITE: DOOR 2 is submit
  // having ALREADY RUN and its stamp failing; this door is cleanup reaching this gate while
  // submit has NOT RUN yet (or is still inside its retry window), so `submitted_at` is still
  // NULL, the gate reads FALSE, and cleanup would proceed. When submit finally runs,
  // `handleSubmit`'s own `dailyRecordingId === null || sourceDeletedAt !== null` gate refuses
  // to call Daily and skips with reason `no_daily_source` — a clean, logged no-op from THAT
  // job's point of view, but a SILENT transcript loss for the segment.
  //
  // MITIGATION (BAL-520): the Mux-triggered enqueue (`routes/mux/webhook.ts`) is DELAYED by
  // `TRANSCRIPT_SUBMIT_RETRY_BUDGET_MS` (`transcript-submit-budget.ts`), so submit has stamped
  // `submitted_at` or exhausted its attempts before this gate first reads. The gate itself is
  // unchanged, and the §7.4 re-drive (`routes/daily/webhook.ts`) is NOT delayed.
  //
  // ORDERING: when submit is enqueued at all, it is enqueued in the same `ready-to-download`
  // handler (after the ingest enqueue), before Mux's `ready` can arrive. The race is submit NOT
  // YET STAMPED, not unordered enqueues.
  //
  // RESIDUALS, STATED NOT FIXED — the delay does not cover: (a) queue wait before submit
  // attempt 1 (`transcript-capture` runs `concurrency: 5`, shared with `ingest`); (b) the
  // worker being down; (c) a failed best-effort submit enqueue (`routes/daily/webhook.ts`) —
  // submit never runs, so no delay helps. Each still ends in `no_daily_source`, as do DOOR 2 and
  // a genuinely absent source. (d) Redis data loss while the bare job sits delayed (~75s) with
  // no submit stamped leaks the source; the DOOR 1 query cannot see it (`submitted_at` is NULL).
  // Storage-only — a general stuck-row sweep (BAL-509) is the natural owner.
  //
  // ⚠ FIX ROUND 1 (M9) — DOOR 4, NOT REACHABLE TODAY BUT UNGUARDED THE MOMENT ONE SHIPS:
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
