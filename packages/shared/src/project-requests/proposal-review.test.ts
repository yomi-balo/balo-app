import { describe, expect, it } from 'vitest';
import { proposalAwaitsClientReview, proposalReviewWait } from './proposal-review';

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

describe('proposalReviewWait', () => {
  const early = new Date('2026-11-02T01:00:00Z');
  const late = new Date('2026-11-05T01:00:00Z');

  it('anchors on the earliest awaiting submit time and counts the awaiting rows', () => {
    expect(
      proposalReviewWait([
        {
          relationshipStatus: 'proposal_submitted',
          proposalStatus: 'submitted',
          submittedAt: late,
        },
        { relationshipStatus: 'proposal_submitted', proposalStatus: null, submittedAt: early },
      ])
    ).toEqual({ anchor: early, awaitingCount: 2 });
  });

  it('ignores a proposal the client asked to change, so it neither anchors nor counts', () => {
    expect(
      proposalReviewWait([
        {
          relationshipStatus: 'proposal_submitted',
          proposalStatus: 'changes_requested',
          submittedAt: early,
        },
        {
          relationshipStatus: 'proposal_submitted',
          proposalStatus: 'submitted',
          submittedAt: late,
        },
      ])
    ).toEqual({ anchor: late, awaitingCount: 1 });
  });

  it('is null when only a changes_requested proposal exists', () => {
    expect(
      proposalReviewWait([
        {
          relationshipStatus: 'proposal_submitted',
          proposalStatus: 'changes_requested',
          submittedAt: early,
        },
      ])
    ).toBeNull();
  });

  it('is null for no candidates, a non-awaiting relationship, or no submit time', () => {
    expect(proposalReviewWait([])).toBeNull();
    expect(
      proposalReviewWait([
        { relationshipStatus: 'accepted', proposalStatus: 'submitted', submittedAt: early },
      ])
    ).toBeNull();
    expect(
      proposalReviewWait([
        { relationshipStatus: 'proposal_submitted', proposalStatus: null, submittedAt: null },
      ])
    ).toBeNull();
  });

  it('anchors on the rows that have a submit time when another awaiting row has none', () => {
    expect(
      proposalReviewWait([
        { relationshipStatus: 'proposal_submitted', proposalStatus: null, submittedAt: null },
        { relationshipStatus: 'proposal_submitted', proposalStatus: null, submittedAt: late },
      ])
    ).toEqual({ anchor: late, awaitingCount: 2 });
  });
});
