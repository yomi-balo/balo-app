import { Worker, type Job } from 'bullmq';
import { transcriptsRepository, type TranscriptVendor } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { createLlmClient } from '../services/transcript/llm/anthropic-client.js';
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const worker = new Worker<TranscriptPipelineJobInput>(
    TRANSCRIPT_PIPELINE_QUEUE,
    async (job: Job<TranscriptPipelineJobInput>) => {
      await runTranscriptPipeline(job.data, { llm: createLlmClient() });
    },
    { connection: createRedisConnection(), concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    if (!job) {
      return;
    }
    const attempts = job.opts.attempts ?? RETRY_ATTEMPTS;
    if (job.attemptsMade < attempts) {
      // Not yet exhausted — BullMQ will retry.
      return;
    }
    const stage = err instanceof TranscriptStageError ? err.stage : 'unknown';
    markFailedForCapture(job.data.captureId, stage, err.message).catch(() => undefined);
  });

  return worker;
}
