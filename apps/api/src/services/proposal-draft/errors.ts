import type { ProposalDraftFailureReason } from '@balo/shared/project-requests';

/**
 * A classified, terminal failure — carries the closed `ProposalDraftFailureReason` literal the
 * worker persists via `markFailed`. `cause` (when present) is logged, never persisted.
 */
export class ProposalDraftGenerationError extends Error {
  constructor(
    readonly reason: ProposalDraftFailureReason,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ProposalDraftGenerationError';
  }
}
