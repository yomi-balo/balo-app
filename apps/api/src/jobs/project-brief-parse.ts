import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { NoObjectGeneratedError, TypeValidationError } from 'ai';
import { projectBriefParsesRepository } from '@balo/db';
import type { ProjectBriefFailureReason } from '@balo/shared/project-requests';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { buildJobId, getQueue } from '../lib/queue.js';
import { createAiClient } from '../services/ai/index.js';
import { runProjectBriefParse, ProjectBriefParseError } from '../services/project-brief/parse.js';

const log = createLogger('project-brief-parse-job');

/**
 * BAL-254 — the AI-assisted project-brief parse job. ONE BullMQ job runs the whole parse
 * (validate → read R2 → call the model → map taxonomy → persist). Event-triggered (no cron) —
 * enqueued by `POST /project-briefs/parse` right after the web action writes the row.
 */
export const PROJECT_BRIEF_PARSE_QUEUE = 'project-brief-parse';

export interface ProjectBriefParseJobData {
  /** ⚠ THE ONLY FIELD (Ruling A / D1). No R2 key ever crosses the wire — the worker reads them
   *  from `project_brief_parses.source_documents`, populated only by the validated write path. */
  readonly parseId: string;
}

/**
 * Enqueue a parse job. ⚠ D12 — Regenerate mints a NEW `project_brief_parses` row (new uuid), so
 * the jobId here is per-WRITE, not per-STATE, and cannot dedup against a retained completed job
 * (memory `reference_bullmq_jobid_must_be_per_write_not_per_state`).
 */
export async function enqueueProjectBriefParse(input: { parseId: string }): Promise<void> {
  const queue = getQueue(PROJECT_BRIEF_PARSE_QUEUE);
  await queue.add('parse', { parseId: input.parseId } satisfies ProjectBriefParseJobData, {
    // ⚠ buildJobId ONLY — never a template literal (invariants/colon-free-job-ids.test.ts).
    jobId: buildJobId('project-brief-parse', input.parseId),
    attempts: 2,
    backoff: { type: 'exponential', delay: 2000 },
    // The payload is one uuid — retention is cheap, but a completed job has nothing to keep.
    removeOnComplete: true,
    removeOnFail: { count: 20 },
  });
}

/**
 * ⚠⚠ WHY THIS SUBCLASS EXISTS. By the time `worker.on('failed')` runs, BullMQ has already
 * received whatever the processor threw — a `ProjectBriefParseError` re-thrown bare would just
 * be retried (BullMQ only skips retries for an `UnrecoverableError`), so the processor below
 * MUST wrap it. But a bare `new UnrecoverableError(message)` loses the classified
 * `ProjectBriefFailureReason` — the 'failed' handler would then have nothing but a message
 * string to guess a reason from. This subclass carries the reason across that boundary.
 */
class UnrecoverableProjectBriefError extends UnrecoverableError {
  constructor(
    readonly reason: ProjectBriefFailureReason,
    message: string
  ) {
    super(message);
  }
}

/**
 * Map a job-failure error to the closed failure vocabulary. Never a vendor message.
 *
 * The ONE retryable classification, `invalid_output`, arrives as a RAW
 * `NoObjectGeneratedError`/`TypeValidationError` from the AI SDK (never wrapped) once BullMQ's
 * attempts are exhausted.
 */
function classifyFailure(err: unknown): ProjectBriefFailureReason {
  if (err instanceof UnrecoverableProjectBriefError) return err.reason;
  if (err instanceof NoObjectGeneratedError || err instanceof TypeValidationError) {
    return 'invalid_output';
  }
  return 'unknown';
}

export function startProjectBriefParseWorker(): Worker<ProjectBriefParseJobData> {
  const worker = new Worker<ProjectBriefParseJobData>(
    PROJECT_BRIEF_PARSE_QUEUE,
    async (job: Job<ProjectBriefParseJobData>) => {
      try {
        await runProjectBriefParse(job.data.parseId, {
          ai: createAiClient({ productionRequirementLabel: 'the project brief parser' }),
        });
      } catch (err) {
        if (err instanceof ProjectBriefParseError) {
          // Deterministic/classified failures never benefit from a retry — fail fast, and
          // carry the classified reason across the UnrecoverableError boundary.
          throw new UnrecoverableProjectBriefError(err.reason, err.message);
        }
        throw err;
      }
    },
    { connection: createRedisConnection(), concurrency: 3 }
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 2;
    const terminal = err instanceof UnrecoverableError || job.attemptsMade >= attempts;
    if (!terminal) return;

    const reason = classifyFailure(err);
    projectBriefParsesRepository
      .markFailed({ parseId: job.data.parseId, failureReason: reason })
      .catch((markErr: unknown) => {
        log.error(
          {
            parseId: job.data.parseId,
            error: markErr instanceof Error ? markErr.message : String(markErr),
          },
          'Project brief parse — failed to persist the terminal failure'
        );
      });
  });

  return worker;
}
