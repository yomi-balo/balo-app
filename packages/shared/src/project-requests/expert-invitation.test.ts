import { describe, expect, it } from 'vitest';
import {
  directExpertOwesChoice,
  expertInvitationMove,
  invitationReminderWait,
  type ExpertInvitationFacts,
  type InvitationReminderFacts,
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

describe('invitationReminderWait', () => {
  const INVITED_AT = new Date('2026-11-05T04:00:00.000Z');
  const BASE: InvitationReminderFacts = {
    requestStatus: 'experts_invited',
    relationshipStatus: 'invited',
    onDirectLeg: false,
    availabilitySharedAt: null,
    invitedAt: INVITED_AT,
  };

  it('waits, anchored on the invite instant, while an invitation is unanswered', () => {
    expect(invitationReminderWait(BASE, false)).toEqual({ anchor: INVITED_AT });
  });

  it('waits on a direct request until the expert acts', () => {
    const direct = {
      ...BASE,
      requestStatus: 'eoi_submitted',
      relationshipStatus: 'eoi_submitted',
      onDirectLeg: true,
    };
    expect(invitationReminderWait(direct, false)).toEqual({ anchor: INVITED_AT });
    expect(invitationReminderWait(direct, true)).toBeNull();
    expect(
      invitationReminderWait({ ...direct, availabilitySharedAt: new Date() }, false)
    ).toBeNull();
  });

  it('does not wait once the expert has answered the invitation', () => {
    expect(invitationReminderWait({ ...BASE, relationshipStatus: 'declined' }, false)).toBeNull();
  });

  it.each(['closed', 'accepted', 'kickoff_approved'])(
    'does not wait on a %s request',
    (requestStatus) => {
      expect(invitationReminderWait({ ...BASE, requestStatus }, false)).toBeNull();
    }
  );

  const combinations = ['experts_invited', 'closed'].flatMap((requestStatus) =>
    ['invited', 'eoi_submitted', 'declined'].flatMap((relationshipStatus) =>
      [true, false].flatMap((onDirectLeg) =>
        [true, false].flatMap((shared) =>
          [true, false].map((sentMessage) => ({
            requestStatus,
            relationshipStatus,
            onDirectLeg,
            shared,
            sentMessage,
          }))
        )
      )
    )
  );

  it.each(combinations)('agrees with expertInvitationMove for %o', (combo) => {
    const move = expertInvitationMove({
      requestStatus: combo.requestStatus,
      relationshipStatus: combo.relationshipStatus,
      onDirectLeg: combo.onDirectLeg,
      availabilityShared: combo.shared,
      sentMessage: combo.sentMessage,
    });
    const wait = invitationReminderWait(
      {
        ...BASE,
        requestStatus: combo.requestStatus,
        relationshipStatus: combo.relationshipStatus,
        onDirectLeg: combo.onDirectLeg,
        availabilitySharedAt: combo.shared ? INVITED_AT : null,
      },
      combo.sentMessage
    );
    expect(wait !== null).toBe(move !== null);
  });
});
