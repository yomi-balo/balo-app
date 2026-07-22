import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { transcriptsRepository, type TranscriptVendor } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { trackServer, TRANSCRIPT_SERVER_EVENTS } from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import {
  createLlmClient,
  LlmOutputTruncatedError,
} from '../services/transcript/llm/anthropic-client.js';
import {
  runTranscriptPipeline,
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
  meetingId?: string | null; // nullable no-FK forward seam
  vendor: TranscriptVendor;
  payload: VendorTranscriptPayload; // raw vendor shape
  recordingRef?: string | null; // nullable/deferred — no producer
  durationMs?: number | null;
}

/**
 * Enqueue a transcript pipeline run. The stable `jobId` (`transcript-pipeline--${captureId}`)
 * collapses duplicate enqueues (BullMQ dedup) — the first idempotency layer atop the per-stage
 * gates + the partial-unique `capture_id`.
 */
export async function enqueueTranscriptPipeline(
  input: EnqueueTranscriptPipelineInput
): Promise<void> {
  const queue = getQueue(TRANSCRIPT_PIPELINE_QUEUE);
  await queue.add(
    'run',
    { ...input },
    {
      jobId: `transcript-pipeline--${input.captureId}`,
      attempts: RETRY_ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
    }
  );
}

const log = createLogger('transcript-pipeline');

/**
 * A deterministic (non-retryable) stage failure. Extends BullMQ's `UnrecoverableError` so the
 * queue stops retrying immediately, while still carrying the failing `stage` for `markFailed` +
 * the `transcript_failed` analytic. The worker handler wraps a truncation (`LlmOutputTruncatedError`)
 * in this so a full-transcript Sonnet pass is not re-spent two more times for the same result.
 */
export class UnrecoverableTranscriptStageError extends UnrecoverableError {
  readonly stage: string;

  constructor(stage: string, message: string) {
    super(message);
    this.name = 'UnrecoverableTranscriptStageError';
    this.stage = stage;
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
 * Start the transcript pipeline worker (event-triggered; concurrency 5, own Redis connection).
 * On exhausted attempts, `on('failed')` records `markFailed(stage, reason)` so a permanently
 * failing capture surfaces its failing stage.
 */
export function startTranscriptPipelineWorker(): Worker<TranscriptPipelineJobInput> {
  // Deploy-time signal: in prod without a key EVERY job fails fast (createLlmClient throws). Only
  // fires when a worker is actually started (startWorkers gates on REDIS_URL), so never in dev/CI.
  if (process.env.NODE_ENV === 'production' && (process.env.ANTHROPIC_API_KEY ?? '').length === 0) {
    log.error(
      'ANTHROPIC_API_KEY is not set in production — every transcript pipeline job will fail until it is configured'
    );
  }

  const worker = new Worker<TranscriptPipelineJobInput>(
    TRANSCRIPT_PIPELINE_QUEUE,
    async (job: Job<TranscriptPipelineJobInput>) => {
      try {
        await runTranscriptPipeline(job.data, { llm: createLlmClient() });
      } catch (err) {
        if (err instanceof TranscriptStageError && err.cause instanceof LlmOutputTruncatedError) {
          // Deterministic truncation → surface as UnrecoverableError so BullMQ does NOT retry
          // (a retry would re-spend a full Sonnet pass for the same truncated output).
          throw new UnrecoverableTranscriptStageError(err.stage, err.message);
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
    markFailedForCapture(job.data.captureId, stage, err.message).catch(() => undefined);
    trackServer(TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_FAILED, {
      stage,
      vendor: job.data.vendor,
      distinct_id: 'system:transcript-pipeline',
    });
  });

  return worker;
}
