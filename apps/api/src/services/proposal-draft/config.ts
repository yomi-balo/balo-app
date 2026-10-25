import { resolveModelId } from '../ai/index.js';

/**
 * The composer shows a skeleton until the draft lands, so latency outweighs depth: the default
 * is the faster of the allow-listed models. `PROPOSAL_DRAFT_MODEL` overrides it within the list.
 */
export const DEFAULT_PROPOSAL_DRAFT_MODEL = 'claude-sonnet-5';

export const PROPOSAL_DRAFT_MODEL_ALLOW_LIST = [
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-opus-4-8',
] as const;

export const PROPOSAL_DRAFT_MAX_OUTPUT_TOKENS = 4096;

export function resolveProposalDraftModel(): string {
  return resolveModelId({
    override: process.env.PROPOSAL_DRAFT_MODEL,
    defaultModelId: DEFAULT_PROPOSAL_DRAFT_MODEL,
    allowList: PROPOSAL_DRAFT_MODEL_ALLOW_LIST,
  });
}
