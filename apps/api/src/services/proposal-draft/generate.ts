import { NoObjectGeneratedError, TypeValidationError } from 'ai';
import {
  projectRequestsRepository,
  proposalDraftGenerationsRepository,
  requestExpertRelationshipsRepository,
} from '@balo/db';
import { PROJECT_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import { DRAFT_DEADLINE_MS, type ProposalDraftOutput } from '@balo/shared/project-requests';
import { htmlToPlainText } from '@balo/shared/notifications';
import { createLogger } from '@balo/shared/logging';
import { AiModelNotAllowedError, LlmOutputTruncatedError, type AiClient } from '../ai/index.js';
import { PROPOSAL_DRAFT_MAX_OUTPUT_TOKENS, resolveProposalDraftModel } from './config.js';
import { ProposalDraftGenerationError } from './errors.js';
import { proposalDraftNoopResult } from './noop-fallback.js';
import {
  proposalDraftOutputSchema,
  proposalDraftPrompt,
  type ProposalDraftPromptInput,
  type RenderedProposalDraftPrompt,
} from './prompts.js';

const log = createLogger('proposal-draft-generate');

export { ProposalDraftGenerationError };

export interface GenerateDeps {
  readonly ai: AiClient;
}

/** Fewest visible characters a drafted milestone title may have to count as usable. */
const MIN_USABLE_TITLE_LENGTH = 3;

/**
 * Load the prompt inputs for a generation's relationship. A missing relationship or request
 * (soft-deleted since the row was written) is a terminal `source_unavailable`.
 */
async function loadPromptInput(
  generationId: string,
  relationshipId: string
): Promise<ProposalDraftPromptInput> {
  const relationship = await requestExpertRelationshipsRepository.findById(relationshipId);
  if (relationship === undefined) {
    throw new ProposalDraftGenerationError(
      'source_unavailable',
      `No live relationship for generation ${generationId}`
    );
  }
  const request = await projectRequestsRepository.findByIdWithRelations(
    relationship.projectRequestId
  );
  if (request === undefined) {
    throw new ProposalDraftGenerationError(
      'source_unavailable',
      `No live project request for generation ${generationId}`
    );
  }
  return {
    requestTitle: request.title,
    descriptionText: htmlToPlainText(request.description),
    productNames: request.products.map((p) => p.product.name),
    tagNames: request.tags.map((t) => t.projectTag.name),
    companyName: request.company?.name ?? null,
  };
}

interface DraftGeneration {
  readonly value: ProposalDraftOutput;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly usage: { inputTokens: number | null; outputTokens: number | null };
}

/**
 * Resolve the model and call it, mapping each error class to its failure reason.
 *
 * The retryability split lives here: a disallowed model (misconfiguration) and a truncated
 * answer (deterministic) become `ProposalDraftGenerationError`s, which the job layer re-throws
 * as `UnrecoverableError`. An invalid structured output stays the RAW SDK error so BullMQ's
 * second attempt can have a go; generation is stochastic.
 */
async function generateDraft(
  generationId: string,
  ai: AiClient,
  prompt: RenderedProposalDraftPrompt
): Promise<DraftGeneration> {
  let modelId: string;
  try {
    modelId = resolveProposalDraftModel();
  } catch (error) {
    if (error instanceof AiModelNotAllowedError) {
      log.error({ generationId, error: error.message }, 'Proposal draft — model not allowed');
      throw new ProposalDraftGenerationError('model_unavailable', error.message, error);
    }
    throw error;
  }

  try {
    const result = await ai.generateObject({
      modelId,
      schema: proposalDraftOutputSchema,
      system: prompt.system,
      prompt: prompt.user,
      maxOutputTokens: PROPOSAL_DRAFT_MAX_OUTPUT_TOKENS,
      promptId: prompt.promptId,
      promptVersion: prompt.promptVersion,
      noopFallback: proposalDraftNoopResult,
    });
    return {
      value: result.value,
      modelId: result.audit.modelId,
      promptVersion: result.audit.promptVersion,
      usage: result.usage,
    };
  } catch (error) {
    if (error instanceof LlmOutputTruncatedError) {
      throw new ProposalDraftGenerationError('truncated', error.message, error);
    }
    if (error instanceof NoObjectGeneratedError || error instanceof TypeValidationError) {
      // `error.name`, never `error.message`: a TypeValidationError message embeds the value
      // that failed, which is raw model output.
      log.warn(
        { generationId, errorName: error.name },
        'Proposal draft — model returned an invalid structured output'
      );
    }
    throw error;
  }
}

/** The answer is usable when it has overview text and every milestone title is substantive. */
function meetsUsableFloor(value: ProposalDraftOutput): boolean {
  if (htmlToPlainText(value.overviewHtml).length === 0) return false;
  return value.milestones.every((m) => m.title.trim().length >= MIN_USABLE_TITLE_LENGTH);
}

/**
 * Past the deadline the web has already stopped waiting and reads the row as failed, so a model
 * call (or a late write) would only spend tokens on an answer nobody sees. `createdAt` is the
 * database clock and `Date.now()` the worker's; the skew is negligible against a 90s budget.
 */
function assertWithinDeadline(generationId: string, createdAt: Date, stage: string): void {
  if (Date.now() - createdAt.getTime() <= DRAFT_DEADLINE_MS) return;
  log.warn({ generationId, stage }, 'Proposal draft abandoned — past the draft deadline');
  throw new ProposalDraftGenerationError(
    'deadline_exceeded',
    `Generation ${generationId} passed its deadline ${stage}`
  );
}

async function isStillPending(generationId: string): Promise<boolean> {
  const row = await proposalDraftGenerationsRepository.findById(generationId);
  return row !== undefined && row.status === 'pending';
}

/**
 * The worker's orchestration, in order:
 *  1. Load the row (a settled row is an idempotent no-op).
 *  2. Load the request the expert is answering.
 *  3. Re-check the row is still pending, so a settled row never costs a model call.
 *  4. Abandon as `deadline_exceeded` when the row is already past `DRAFT_DEADLINE_MS`.
 *  5. Call the model.
 *  6. Usable-output floor, then the deadline again (a slow call must not save a result the web
 *     has already stopped waiting for).
 *  7. Persist, firing analytics only when this write won the compare-and-set.
 *
 * Non-retryable classifications are thrown as `ProposalDraftGenerationError` (the job layer maps
 * them to BullMQ's `UnrecoverableError`); an invalid structured output is a plain error so the
 * second attempt can retry.
 */
export async function runProposalDraftGeneration(
  generationId: string,
  deps: GenerateDeps
): Promise<void> {
  const row = await proposalDraftGenerationsRepository.findById(generationId);
  if (row === undefined) {
    throw new ProposalDraftGenerationError(
      'unknown',
      `No proposal_draft_generations row for ${generationId}`
    );
  }
  if (row.status !== 'pending') return;

  const input = await loadPromptInput(generationId, row.relationshipId);

  // The web's `enqueue_failed` write can race this job. One SELECT is far cheaper than the paid
  // call it can avoid. It narrows the window rather than closing it; the compare-and-set keeps
  // the outcome correct either way.
  if (!(await isStillPending(generationId))) {
    log.info({ generationId }, 'Proposal draft abandoned before the model call — row is settled');
    return;
  }

  assertWithinDeadline(generationId, row.createdAt, 'before the model call');

  const generation = await generateDraft(generationId, deps.ai, proposalDraftPrompt(input));

  if (!meetsUsableFloor(generation.value)) {
    throw new ProposalDraftGenerationError('empty_output', 'Model output below the usable floor');
  }
  assertWithinDeadline(generationId, row.createdAt, 'before the result was saved');

  const updated = await proposalDraftGenerationsRepository.markSucceeded({
    generationId,
    output: generation.value,
    modelId: generation.modelId,
    promptVersion: generation.promptVersion,
    inputTokens: generation.usage.inputTokens,
    outputTokens: generation.usage.outputTokens,
  });
  if (updated === undefined) return;

  const completedAtMs = (updated.completedAt ?? new Date()).getTime();
  trackServer(PROJECT_SERVER_EVENTS.PROPOSAL_DRAFT_GENERATED, {
    relationship_id: updated.relationshipId,
    status: 'succeeded',
    latency_ms: completedAtMs - updated.createdAt.getTime(),
    milestone_count: generation.value.milestones.length,
    distinct_id: updated.requestedByUserId,
  });

  log.info(
    {
      generationId,
      modelId: generation.modelId,
      inputTokens: generation.usage.inputTokens,
      outputTokens: generation.usage.outputTokens,
      milestoneCount: generation.value.milestones.length,
      promptVersion: generation.promptVersion,
    },
    'Proposal draft generated'
  );
}
