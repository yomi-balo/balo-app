import { describe, expect, it } from 'vitest';
import { proposalAwaitsClientReview } from './proposal-review';

describe('proposalAwaitsClientReview', () => {
  it.each([
    ['proposal_submitted', null, true],
    ['proposal_submitted', 'submitted', true],
    ['proposal_submitted', 'changes_requested', false],
    ['accepted', 'submitted', false],
    ['eoi_submitted', null, false],
  ] as const)('%s with current proposal %s → %s', (relationship, proposal, expected) => {
    expect(proposalAwaitsClientReview(relationship, proposal)).toBe(expected);
  });
});
