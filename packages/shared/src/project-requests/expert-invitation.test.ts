import { describe, expect, it } from 'vitest';
import {
  directExpertOwesChoice,
  expertInvitationMove,
  type ExpertInvitationFacts,
} from './expert-invitation';

const DIRECT: ExpertInvitationFacts = {
  requestStatus: 'eoi_submitted',
  onDirectLeg: true,
  relationshipStatus: 'eoi_submitted',
  availabilityShared: false,
  sentMessage: false,
};

const INVITED: ExpertInvitationFacts = {
  ...DIRECT,
  requestStatus: 'experts_invited',
  onDirectLeg: false,
  relationshipStatus: 'invited',
};

describe('directExpertOwesChoice', () => {
  it('is true for the direct-leg expert at eoi_submitted who has not acted', () => {
    expect(directExpertOwesChoice(DIRECT)).toBe(true);
  });

  it('turns false once the expert shares availability', () => {
    expect(directExpertOwesChoice({ ...DIRECT, availabilityShared: true })).toBe(false);
  });

  it('turns false once the expert sends a message', () => {
    expect(directExpertOwesChoice({ ...DIRECT, sentMessage: true })).toBe(false);
  });

  it('is false off the direct leg', () => {
    expect(directExpertOwesChoice({ ...DIRECT, onDirectLeg: false })).toBe(false);
  });

  it.each(['invited', 'proposal_requested', 'proposal_submitted', 'accepted', 'declined'])(
    'is false at %s',
    (relationshipStatus) => {
      expect(directExpertOwesChoice({ ...DIRECT, relationshipStatus })).toBe(false);
    }
  );
});

describe('expertInvitationMove', () => {
  it('is invitation for an invited relationship', () => {
    expect(expertInvitationMove(INVITED)).toBe('invitation');
  });

  it('is direct_request for an unanswered direct request', () => {
    expect(expertInvitationMove(DIRECT)).toBe('direct_request');
  });

  it.each(['closed', 'accepted', 'kickoff_approved'])(
    'is null on a %s request, on any relationship status',
    (requestStatus) => {
      expect(expertInvitationMove({ ...INVITED, requestStatus })).toBeNull();
      expect(expertInvitationMove({ ...DIRECT, requestStatus })).toBeNull();
      expect(
        expertInvitationMove({ ...DIRECT, requestStatus, relationshipStatus: 'accepted' })
      ).toBeNull();
    }
  );

  it('is null for an eoi_submitted relationship off the direct leg', () => {
    expect(expertInvitationMove({ ...DIRECT, onDirectLeg: false })).toBeNull();
  });

  it('is null on the direct leg once availability is shared or a message is sent', () => {
    expect(expertInvitationMove({ ...DIRECT, availabilityShared: true })).toBeNull();
    expect(expertInvitationMove({ ...DIRECT, sentMessage: true })).toBeNull();
  });

  it.each(['proposal_requested', 'proposal_submitted', 'declined'])(
    'is null at relationship status %s',
    (relationshipStatus) => {
      expect(expertInvitationMove({ ...DIRECT, relationshipStatus })).toBeNull();
    }
  );
});
