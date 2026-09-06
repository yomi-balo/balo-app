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

describe('deriveRequestStatus — BAL-540 rule 1: a terminal state wins', () => {
  it('current closed + any live relationship set → stays closed', () => {
    // The close cascade declines every track it finds, but a track inserted after its
    // snapshot (or one that was terminal and skipped) must never argue the request open.
    expect(deriveRequestStatus(['invited', 'eoi_submitted', 'proposal_submitted'], 'closed')).toBe(
      'closed'
    );
  });

  it('current closed + an accepted relationship → still closed', () => {
    // `accepted` outranks every other relationship-expressible status, so this is the
    // strongest possible argument against the terminal — and it still loses.
    expect(deriveRequestStatus(['accepted'], 'closed')).toBe('closed');
  });

  it('current closed + empty set → closed', () => {
    expect(deriveRequestStatus([], 'closed')).toBe('closed');
  });
});

describe('deriveRequestStatus — BAL-540 rule 2: a decline may LOWER, down to the floor', () => {
  it('declining the FURTHEST track drops the request to its furthest LIVE track', () => {
    // The kanban requirement. The proposal_submitted track is now `declined`; one live
    // track remains at eoi_submitted, so the request follows it DOWN. Under the old
    // pure-floor rule this returned `proposal_submitted`.
    expect(deriveRequestStatus(['declined', 'eoi_submitted'], 'proposal_submitted')).toBe(
      'eoi_submitted'
    );
  });

  it('declining a NON-furthest track moves nothing', () => {
    expect(deriveRequestStatus(['declined', 'proposal_submitted'], 'proposal_submitted')).toBe(
      'proposal_submitted'
    );
  });

  it('lowers only to the furthest live track, not to the earliest one', () => {
    expect(
      deriveRequestStatus(['declined', 'invited', 'proposal_requested'], 'proposal_submitted')
    ).toBe('proposal_requested');
  });

  it('does NOT lower below an admin milestone: accepted survives a decline', () => {
    // The floor half of the rule, stated as its own case beside the lowering ones so the
    // two halves are visibly one rule. `accepted` is a milestone no relationship expresses.
    expect(deriveRequestStatus(['declined', 'eoi_submitted'], 'accepted')).toBe('accepted');
  });

  it('does NOT lower below exploratory_meeting_requested', () => {
    expect(deriveRequestStatus(['declined'], 'exploratory_meeting_requested')).toBe(
      'exploratory_meeting_requested'
    );
  });

  it('lowers a request whose only live track is behind it (experts_invited is NOT a floor)', () => {
    // `experts_invited` IS relationship-expressible, so it is deliberately absent from the
    // milestone set: a request sitting at eoi_submitted whose only remaining live track is
    // still `invited` must drop back to experts_invited.
    expect(deriveRequestStatus(['declined', 'invited'], 'eoi_submitted')).toBe('experts_invited');
  });
});
