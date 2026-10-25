import { describe, it, expect } from 'vitest';
import {
  proposalDraftNoopResult,
  PROPOSAL_DRAFT_NOOP_ACCEPTANCE_CRITERIA,
  PROPOSAL_DRAFT_NOOP_DISCLAIMER,
  PROPOSAL_DRAFT_NOOP_MILESTONE_TITLES,
} from './noop-fallback.js';
import { proposalDraftOutputSchema } from './prompts.js';

// The literals are written out in full, not derived from the module's constants, so an edit to
// the copy has to be looked at here rather than silently re-deriving itself green.
describe('proposalDraftNoopResult', () => {
  it('the synthetic marker is present, verbatim', () => {
    expect(PROPOSAL_DRAFT_NOOP_DISCLAIMER).toBe(
      'Development placeholder — no model was called, so this draft was not written from the request.'
    );
    expect(PROPOSAL_DRAFT_NOOP_MILESTONE_TITLES).toEqual([
      'Placeholder milestone one',
      'Placeholder milestone two',
    ]);
  });

  it('carries the disclaimer in the overview and every milestone, so a stub is never mistaken for a draft', () => {
    const result = proposalDraftNoopResult();
    expect(result.overviewHtml).toBe(`<p>${PROPOSAL_DRAFT_NOOP_DISCLAIMER}</p>`);
    expect(result.milestones).toHaveLength(2);
    for (const milestone of result.milestones) {
      expect(milestone.descriptionHtml).toContain(PROPOSAL_DRAFT_NOOP_DISCLAIMER);
    }
  });

  it('writes the completion condition without the "Done when" label the composer already shows', () => {
    expect(PROPOSAL_DRAFT_NOOP_ACCEPTANCE_CRITERIA).toBe(
      'This placeholder is replaced with real content.'
    );
    for (const milestone of proposalDraftNoopResult().milestones) {
      expect(milestone.acceptanceCriteria).toBe('This placeholder is replaced with real content.');
      expect(milestone.acceptanceCriteria).not.toMatch(/^done when/i);
    }
  });

  it('satisfies the output schema, so the dev/CI path exercises the same shape a real draft has', () => {
    expect(proposalDraftOutputSchema.safeParse(proposalDraftNoopResult()).success).toBe(true);
  });
});
