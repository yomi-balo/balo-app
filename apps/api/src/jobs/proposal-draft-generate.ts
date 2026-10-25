import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { NoObjectGeneratedError, TypeValidationError } from 'ai';
import { proposalDraftGenerationsRepository } from '@balo/db';
import { PROJECT_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import type { ProposalDraftFailureReason } from '@balo/shared/project-requests';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { buildJobId, getQueue } from '../lib/queue.js';
import { createAiClient } from '../services/ai/index.js';
import {
  runProposalDraftGeneration,
  ProposalDraftGenerationError,
} from '../services/proposal-draft/generate.js';

const log = createLogger('proposal-draft-generate-job');

/**
 * The AI proposal-draft job. ONE BullMQ job runs the whole generation (load → model → persist).
 * Event-triggered (no cron): enqueued by `POST /proposal-drafts/generate` after the web action
 * writes the row.
 */
export const PROPOSAL_DRAFT_GENERATE_QUEUE = 'proposal-draft-generate';

export interface ProposalDraftGenerateJobData {
  /** The only field: the worker reads everything else from the row. */
  readonly generationId: string;
}

/**
 * Enqueue a generation job. There is one generation per relationship, so the jobId is per row;
 * `removeOnComplete` frees the id once the job is done.
 */
export async function enqueueProposalDraftGenerate(input: { generationId: string }): Promise<void> {
  const queue = getQueue(PROPOSAL_DRAFT_GENERATE_QUEUE);
  await queue.add(
    'generate',
    { generationId: input.generationId } satisfies ProposalDraftGenerateJobData,
    {
      // buildJobId ONLY — never a template literal (invariants/colon-free-job-ids.test.ts).
      jobId: buildJobId('proposal-draft-generate', input.generationId),
      attempts: 2,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: { count: 20 },
    }
  );
}

/**
 * Carries the classified failure reason across BullMQ's `UnrecoverableError` boundary. A bare
 * `ProposalDraftGenerationError` would just be retried, and a bare `UnrecoverableError` would
 * leave the 'failed' handler guessing a reason from a message string.
 */
class UnrecoverableProposalDraftError extends UnrecoverableError {
  constructor(
    readonly reason: ProposalDraftFailureReason,
    message: string
  ) {
    super(message);
  }
}

/**
 * Map a job-failure error to the closed failure vocabulary. Never a vendor message. The one
 * retryable classification, `invalid_output`, arrives as a raw AI SDK error once BullMQ's
 * attempts are exhausted.
 */
function classifyFailure(err: unknown): ProposalDraftFailureReason {
  if (err instanceof UnrecoverableProposalDraftError) return err.reason;
  if (err instanceof NoObjectGeneratedError || err instanceof TypeValidationError) {
    return 'invalid_output';
  }
  return 'unknown';
}

async function persistTerminalFailure(
  generationId: string,
  reason: ProposalDraftFailureReason
): Promise<void> {
  const updated = await proposalDraftGenerationsRepository.markFailed({
    generationId,
    failureReason: reason,
  });
  if (updated === undefined) return;

  const completedAtMs = (updated.completedAt ?? new Date()).getTime();
  trackServer(PROJECT_SERVER_EVENTS.PROPOSAL_DRAFT_GENERATED, {
    relationship_id: updated.relationshipId,
    status: 'failed',
    latency_ms: completedAtMs - updated.createdAt.getTime(),
    milestone_count: 0,
    distinct_id: updated.requestedByUserId,
  });
}

export function startProposalDraftGenerateWorker(): Worker<ProposalDraftGenerateJobData> {
  const worker = new Worker<ProposalDraftGenerateJobData>(
    PROPOSAL_DRAFT_GENERATE_QUEUE,
    async (job: Job<ProposalDraftGenerateJobData>) => {
      try {
        await runProposalDraftGeneration(job.data.generationId, {
          ai: createAiClient({ productionRequirementLabel: 'the proposal draft generator' }),
        });
      } catch (error) {
        if (error instanceof ProposalDraftGenerationError) {
          // Classified failures never benefit from a retry; carry the reason across.
          throw new UnrecoverableProposalDraftError(error.reason, error.message);
        }
        throw error;
      }
    },
    { connection: createRedisConnection(), concurrency: 3 }
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 2;
    const terminal = err instanceof UnrecoverableError || job.attemptsMade >= attempts;
    if (!terminal) return;

    persistTerminalFailure(job.data.generationId, classifyFailure(err)).catch((error: unknown) => {
      // `err`, not a hand-flattened message: this is the line that explains why a row stays
      // `pending` until the read-side deadline derivation rescues it.
      log.error(
        { err: error, generationId: job.data.generationId },
        'Proposal draft — failed to persist the terminal failure'
      );
    });
  });

  return worker;
}
