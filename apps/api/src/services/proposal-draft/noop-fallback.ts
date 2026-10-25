import type { ProposalDraftOutput } from '@balo/shared/project-requests';

/**
 * The synthetic markers. Exported as constants and asserted against these exact literals in
 * `noop-fallback.test.ts`, because the point of this stub is that a person looking at a dev/CI
 * draft can tell at a glance that no model read the request.
 */
export const PROPOSAL_DRAFT_NOOP_DISCLAIMER =
  'Development placeholder — no model was called, so this draft was not written from the request.';

export const PROPOSAL_DRAFT_NOOP_MILESTONE_TITLES = [
  'Placeholder milestone one',
  'Placeholder milestone two',
] as const;

/**
 * DEV/CI ONLY — unreachable in production (`createAiClient` throws when the key is absent).
 * Lets dev and CI exercise the whole path end to end without a key. The row carries
 * `model_id = 'noop'`, which is how an operator tells a stub from a real draft.
 */
export function proposalDraftNoopResult(): ProposalDraftOutput {
  return {
    overviewHtml: `<p>${PROPOSAL_DRAFT_NOOP_DISCLAIMER}</p>`,
    milestones: PROPOSAL_DRAFT_NOOP_MILESTONE_TITLES.map((title) => ({
      title,
      descriptionHtml: `<p>${PROPOSAL_DRAFT_NOOP_DISCLAIMER}</p>`,
      acceptanceCriteria: 'Done when this placeholder is replaced with real content.',
    })),
  };
}
