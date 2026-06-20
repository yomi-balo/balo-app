import { describe, it, expect } from 'vitest';
import { deriveRequestStatus, RELATIONSHIP_TO_REQUEST_STATUS } from './derive-request-status';
import type { ProjectRequest, RequestExpertRelationship } from '../../schema';

type ProjectRequestStatus = ProjectRequest['status'];
type RelationshipStatus = RequestExpertRelationship['status'];

describe('deriveRequestStatus — single relationship maps in lockstep', () => {
  // Each non-declined relationship status, paired with the request status it
  // SHOULD derive when the request is at its pre-relationship floor.
  const stages: Array<{
    relationship: RelationshipStatus;
    current: ProjectRequestStatus;
    expected: ProjectRequestStatus;
  }> = [
    { relationship: 'invited', current: 'experts_invited', expected: 'experts_invited' },
    { relationship: 'eoi_submitted', current: 'experts_invited', expected: 'eoi_submitted' },
    {
      relationship: 'proposal_requested',
      current: 'eoi_submitted',
      expected: 'proposal_requested',
    },
    {
      relationship: 'proposal_submitted',
      current: 'proposal_requested',
      expected: 'proposal_submitted',
    },
    { relationship: 'accepted', current: 'proposal_submitted', expected: 'accepted' },
  ];

  it.each(stages)(
    'rel $relationship (current $current) → $expected',
    ({ relationship, current, expected }) => {
      expect(deriveRequestStatus([relationship], current)).toBe(expected);
    }
  );
});

describe('deriveRequestStatus — max-progress over a mixed set', () => {
  it('derives the FURTHEST-along status across relationships', () => {
    // proposal_submitted is the furthest non-declined; eoi_submitted is behind it,
    // declined contributes nothing.
    expect(
      deriveRequestStatus(['proposal_submitted', 'eoi_submitted', 'declined'], 'experts_invited')
    ).toBe('proposal_submitted');
  });

  it('is order-independent (same set, shuffled, same result)', () => {
    expect(
      deriveRequestStatus(['eoi_submitted', 'declined', 'proposal_submitted'], 'experts_invited')
    ).toBe('proposal_submitted');
  });
});

describe('deriveRequestStatus — declined contributes nothing', () => {
  it('ignores a declined relationship in a mixed set (eoi wins over declined)', () => {
    expect(deriveRequestStatus(['eoi_submitted', 'declined'], 'experts_invited')).toBe(
      'eoi_submitted'
    );
  });

  it('all-declined → returns currentRequestStatus unchanged (stays experts_invited)', () => {
    expect(deriveRequestStatus(['declined', 'declined'], 'experts_invited')).toBe(
      'experts_invited'
    );
  });

  it('empty set → returns currentRequestStatus unchanged', () => {
    expect(deriveRequestStatus([], 'experts_invited')).toBe('experts_invited');
  });
});

describe('deriveRequestStatus — never regresses below current', () => {
  it('current exploratory_meeting_requested + rel invited → advances to experts_invited', () => {
    // The enum declares exploratory_meeting_requested (idx 2) BEFORE
    // experts_invited (idx 3), so `invited` → `experts_invited` is a legitimate
    // FORWARD advance, not a regress — the request follows its invited relationship.
    expect(deriveRequestStatus(['invited'], 'exploratory_meeting_requested')).toBe(
      'experts_invited'
    );
  });

  it('current experts_invited + rel invited → stays experts_invited (no regress, no jump)', () => {
    // invited maps to experts_invited; the request is already there → unchanged.
    expect(deriveRequestStatus(['invited'], 'experts_invited')).toBe('experts_invited');
  });

  it('current exploratory_meeting_requested + rel eoi_submitted → advances to eoi_submitted', () => {
    expect(deriveRequestStatus(['eoi_submitted'], 'exploratory_meeting_requested')).toBe(
      'eoi_submitted'
    );
  });

  it('current kickoff_approved + any rel set → stays kickoff_approved (terminal, never clobbered)', () => {
    expect(
      deriveRequestStatus(['invited', 'eoi_submitted', 'proposal_submitted'], 'kickoff_approved')
    ).toBe('kickoff_approved');
  });

  it('current accepted + rel invited → stays accepted (a re-invited expert never regresses the request)', () => {
    expect(deriveRequestStatus(['invited'], 'accepted')).toBe('accepted');
  });
});

describe('deriveRequestStatus — second-expert-same-stage is idempotent', () => {
  it('two eoi_submitted with current eoi_submitted → eoi_submitted (no error, no jump)', () => {
    expect(deriveRequestStatus(['eoi_submitted', 'eoi_submitted'], 'eoi_submitted')).toBe(
      'eoi_submitted'
    );
  });
});

describe('deriveRequestStatus — naming-trap scope translation', () => {
  it('rel proposal_requested → request proposal_requested (scope translation, not identity short-circuit)', () => {
    expect(deriveRequestStatus(['proposal_requested'], 'eoi_submitted')).toBe('proposal_requested');
  });

  it('the map is a deliberate scope translation that excludes declined', () => {
    expect(RELATIONSHIP_TO_REQUEST_STATUS).toEqual({
      invited: 'experts_invited',
      eoi_submitted: 'eoi_submitted',
      proposal_requested: 'proposal_requested',
      proposal_submitted: 'proposal_submitted',
      accepted: 'accepted',
    });
    expect('declined' in RELATIONSHIP_TO_REQUEST_STATUS).toBe(false);
  });
});
