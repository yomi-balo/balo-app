import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { transcriptsRepository, type TranscriptVendor } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { trackServer, TRANSCRIPT_SERVER_EVENTS } from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { buildJobId, getQueue } from '../lib/queue.js';
import {
  createLlmClient,
  LlmOutputTruncatedError,
} from '../services/transcript/llm/anthropic-client.js';
import {
  runTranscriptPipeline,
  resumeTranscriptRecap,
  TranscriptStageError,
  type TranscriptPipelineJobInput,
} from '../services/transcript/pipeline.js';
import type { VendorTranscriptPayload } from '../services/transcript/normalizers/index.js';

/**
 * BAL-387 (ADR-1013 + ADR-1043) — the transcript pipeline job. ONE BullMQ job runs all stages
 * in order, each gated by a durable completion marker (crash-resume for free). Event-triggered
 * (no cron); the future capture layer (BAL-126/BAL-140) calls `enqueueTranscriptPipeline`.
 */
export const TRANSCRIPT_PIPELINE_QUEUE = 'transcript-pipeline';

/** Retry policy — 3 attempts, exponential backoff (mirrors the notifications publisher). */
const RETRY_ATTEMPTS = 3;
const BACKOFF_DELAY_MS = 2000;

/** The inert entry seam — the ONLY thing the future capture layer calls. */
export interface EnqueueTranscriptPipelineInput {
  captureId: string; // stable dedup id → jobId + transcripts.capture_id
  engagementId: string; // NOT NULL anchor
  // BAL-418: REQUIRED. `transcripts.meeting_id` is a NOT NULL FK → `meetings.id` now, so this is
  // no longer a forward seam — the capture layer (BAL-126/BAL-140) MUST resolve the meeting first.
  meetingId: string;
  vendor: TranscriptVendor;
  payload: VendorTranscriptPayload; // raw vendor shape
  durationMs?: number | null;
}

/**
 * Enqueue a transcript pipeline run. The stable `jobId` (`transcript-pipeline--${captureId}`)
 * collapses duplicate enqueues (BullMQ dedup) — the first idempotency layer atop the per-stage
 * gates + the partial-unique `capture_id`.
 *
 * ⚠⚠ FIX ROUND (F4) — THIS ENQUEUE CARRIES THE FULL VENDOR TRANSCRIPT (`payload`), NOT JUST
 * IDS, AND THAT IS DELIBERATE, NOT AN OVERSIGHT. BAL-531 makes this jobId collision-free for the
 * first time (it used to throw at `queue.add` on the `daily-batch:{id}` shape, so this enqueue
 * had never actually landed), which means the queue's job DATA — the complete adapted Deepgram
 * transcript, a real consultation recording — is about to sit in Redis for the first time too.
 * The obvious mitigation, enqueue only `captureId` and have the worker re-read the transcript
 * row, does NOT apply here: `stagePersistRaw`
 * (`services/transcript/pipeline.ts`) is what WRITES the `transcripts` row, from `job.payload`,
 * and it runs AFTER this enqueue, inside the worker. At the moment this function is called, the
 * caller (`jobs/transcript-capture.ts`'s `handleIngest`) has only just confirmed
 * `transcriptsRepository.findByCaptureId` returns `undefined` — no row exists yet for the
 * worker to re-read. Slimming the payload here would leave the worker with nothing to persist.
 *
 * The fallback instead: keep the payload, but stop RETAINING it. `removeOnComplete: true` means
 * a successfully processed job (row now persisted, transcript no longer only-in-Redis) is
 * deleted immediately rather than sitting in the shared `{ count: 100 }` default. `removeOnFail`
 * keeps a SMALL number for debugging a genuinely failing capture, rather than the shared
 * `{ count: 500 }` default — bounding how many verbatim transcripts can be at rest at once, on
 * THIS queue only (`lib/queue.ts`'s `DEFAULT_JOB_OPTIONS` is unchanged for every other queue).
 */
export async function enqueueTranscriptPipeline(
  input: EnqueueTranscriptPipelineInput
): Promise<void> {
  const queue = getQueue(TRANSCRIPT_PIPELINE_QUEUE);
  await queue.add(
    TRANSCRIPT_PIPELINE_JOB_RUN,
    { ...input },
    {
      jobId: buildJobId('transcript-pipeline', input.captureId),
      attempts: RETRY_ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
      // F4 — do not retain a completed job's full transcript payload; keep only a handful of
      // failures for debugging. Scoped to THIS queue via per-call job options, matching the
      // codebase's existing pattern (e.g. `availability-cache.ts`, `calendar-subscription-
      // reconcile.ts`) for overriding `lib/queue.ts`'s shared defaults on one queue.
      removeOnComplete: true,
      removeOnFail: { count: 10 },
    }
  );
}

/**
 * BAL-550 (D2, D5) — the admin re-drive's job name. `job.name` is distinct from `'run'` for Bull
 * Board legibility, but the PAYLOAD (`resume: true`) is the routing authority — see
 * {@link isResumeJobData}.
 */
export const TRANSCRIPT_PIPELINE_JOB_RUN = 'run';
export const TRANSCRIPT_PIPELINE_JOB_RESUME = 'resume';

/**
 * BAL-550 (D5) — the admin re-drive's job payload. ID-ONLY, DELIBERATELY: no vendor payload
 * (none survives capture — see `enqueueTranscriptPipeline`'s docblock) and NO
 * `meeting_recordings.id`, so this payload cannot even ADDRESS a `transcript_job_*` column.
 * The type-level brace lives in `packages/db/src/repositories/transcripts.ts` (where `apps/api`'s
 * `tsc` actually reaches it — vitest strips types, so a test file could not hold it); the runtime
 * half is `transcripts.redrive-type.test.ts`.
 */
export interface TranscriptRecapResumeJobData {
  readonly resume: true;
  readonly transcriptId: string;
  readonly auditEventId: string;
}

/** Same queue, worker, retry policy and `removeOnComplete` as the capture job — discriminated
 *  by payload shape, never by a second queue. */
export type TranscriptPipelineJobData = TranscriptPipelineJobInput | TranscriptRecapResumeJobData;

/**
 * COMPILER-CHECKED NARROWING — `'resume' in data` narrows the union (the `in` operator narrows
 * in TS), so no hand-written predicate body is trusted to agree with the type. Every job
 * written before this deploy lacks `resume`, so it falls to the capture arm untouched — no
 * in-flight job changes meaning across the deploy boundary.
 */
function isResumeJobData(data: TranscriptPipelineJobData): data is TranscriptRecapResumeJobData {
  return 'resume' in data;
}

/**
 * BAL-550 (D2) — enqueue the admin re-drive's resume job. `jobId` is
 * `buildJobId('transcript-pipeline', transcriptId, 'redrive-' + auditEventId)` — DISJOINT from
 * the capture-id shape (`transcript-pipeline--<captureId>`), so a retained failed capture job
 * cannot swallow a re-drive under the same id (D2's "re-state the parts, never wrap the
 * original id"). Same queue, retry policy and `removeOnComplete` as the capture enqueue.
 */
export async function enqueueTranscriptRecapResume(input: {
  transcriptId: string;
  auditEventId: string;
}): Promise<string> {
  const queue = getQueue(TRANSCRIPT_PIPELINE_QUEUE);
  const data: TranscriptRecapResumeJobData = {
    resume: true,
    transcriptId: input.transcriptId,
    auditEventId: input.auditEventId,
  };
  const jobId = buildJobId(
    'transcript-pipeline',
    input.transcriptId,
    `redrive-${input.auditEventId}`
  );
  await queue.add(TRANSCRIPT_PIPELINE_JOB_RESUME, data, {
    jobId,
    attempts: RETRY_ATTEMPTS,
    backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
    removeOnComplete: true,
    removeOnFail: { count: 10 },
  });
  return jobId;
}

const log = createLogger('transcript-pipeline');

/**
 * A deterministic (non-retryable) stage failure. Extends BullMQ's `UnrecoverableError` so the
 * queue stops retrying immediately, while still carrying the failing `stage` for `markFailed` +
 * the `transcript_failed` analytic. The worker handler wraps a truncation (`LlmOutputTruncatedError`)
 * in this so a full-transcript Sonnet pass is not re-spent two more times for the same result.
 * Preserves the original error as `cause` so the underlying stack survives to Sentry.
 */
export class UnrecoverableTranscriptStageError extends UnrecoverableError {
  readonly stage: string;

  constructor(stage: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'UnrecoverableTranscriptStageError';
    this.stage = stage;
    this.cause = cause;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The failing stage from either stage-carrying error type; `'unknown'` otherwise. */
function stageOf(err: unknown): string {
  if (err instanceof TranscriptStageError) {
    return err.stage;
  }
  if (err instanceof UnrecoverableTranscriptStageError) {
    return err.stage;
  }
  return 'unknown';
}

/** On exhausted retries, stamp the transcript failed (best-effort; row may not exist yet). */
async function markFailedForCapture(
  captureId: string,
  stage: string,
  reason: string
): Promise<void> {
  try {
    const transcript = await transcriptsRepository.findByCaptureId(captureId);
    if (transcript !== undefined) {
      await transcriptsRepository.markFailed(transcript.id, stage, reason);
    }
  } catch (error) {
    log.error(
      { captureId, error: errorMessage(error) },
      'Failed to mark transcript failed on exhausted retries'
    );
  }
}

/**
 * BAL-550 — the resume arm's terminal-failure counterpart to {@link markFailedForCapture}. Keyed
 * on `transcriptId` (the resume payload carries no `captureId`); best-effort, and takes `vendor`
 * OFF THE ROW for the `TRANSCRIPT_FAILED` analytic, since the resume payload carries none. This
 * CLOSES THE LOOP: a failed re-run returns the row to `failed` with the NEW stage, so
 * `transcript.failed` re-raises in the pending-actions queue and the capture-health lens shows
 * `failed` again.
 */
async function markFailedForTranscript(
  transcriptId: string,
  stage: string,
  reason: string
): Promise<TranscriptVendor | undefined> {
  try {
    const transcript = await transcriptsRepository.findById(transcriptId);
    if (transcript === undefined) {
      return undefined;
    }
    await transcriptsRepository.markFailed(transcript.id, stage, reason);
    return transcript.vendor;
  } catch (error) {
    log.error(
      { transcriptId, error: errorMessage(error) },
      'Failed to mark transcript failed on exhausted retries (resume arm)'
    );
    return undefined;
  }
}

/**
 * Start the transcript pipeline worker (event-triggered; concurrency 5, own Redis connection).
 * On exhausted attempts, `on('failed')` records `markFailed(stage, reason)` so a permanently
 * failing capture surfaces its failing stage.
 */
export function startTranscriptPipelineWorker(): Worker<TranscriptPipelineJobData> {
  // Deploy-time signal: in prod without a key EVERY job fails fast (createLlmClient throws). Only
  // fires when a worker is actually started (startWorkers gates on REDIS_URL), so never in dev/CI.
  if (process.env.NODE_ENV === 'production' && (process.env.ANTHROPIC_API_KEY ?? '').length === 0) {
    log.error(
      'ANTHROPIC_API_KEY is not set in production — every transcript pipeline job will fail until it is configured'
    );
  }

  const worker = new Worker<TranscriptPipelineJobData>(
    TRANSCRIPT_PIPELINE_QUEUE,
    async (job: Job<TranscriptPipelineJobData>) => {
      try {
        if (isResumeJobData(job.data)) {
          await resumeTranscriptRecap(job.data, { llm: createLlmClient() });
        } else {
          await runTranscriptPipeline(job.data, { llm: createLlmClient() });
        }
      } catch (err) {
        if (err instanceof TranscriptStageError && err.cause instanceof LlmOutputTruncatedError) {
          // Deterministic truncation → surface as UnrecoverableError so BullMQ does NOT retry
          // (a retry would re-spend a full Sonnet pass for the same truncated output). Pass the
          // original error as `cause` so the LlmOutputTruncatedError stack survives to Sentry.
          throw new UnrecoverableTranscriptStageError(err.stage, err.message, err);
        }
        throw err;
      }
    },
    { connection: createRedisConnection(), concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    if (!job) {
      return;
    }
    const attempts = job.opts.attempts ?? RETRY_ATTEMPTS;
    // Terminal when unrecoverable (deterministic — no retry, even at attemptsMade=1) OR exhausted.
    const terminal = err instanceof UnrecoverableError || job.attemptsMade >= attempts;
    if (!terminal) {
      // Recoverable and attempts remain — BullMQ will retry.
      return;
    }
    const stage = stageOf(err);
    if (isResumeJobData(job.data)) {
      // BAL-550 — the resume arm keyed on transcriptId, vendor taken off the row (the resume
      // payload carries none).
      markFailedForTranscript(job.data.transcriptId, stage, err.message)
        .then((vendor) => {
          if (vendor === undefined) return;
          trackServer(TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_FAILED, {
            stage,
            vendor,
            distinct_id: 'system:transcript-pipeline',
          });
        })
        .catch(() => undefined);
      return;
    }
    markFailedForCapture(job.data.captureId, stage, err.message).catch(() => undefined);
    trackServer(TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_FAILED, {
      stage,
      vendor: job.data.vendor,
      distinct_id: 'system:transcript-pipeline',
    });
  });

  return worker;
}
