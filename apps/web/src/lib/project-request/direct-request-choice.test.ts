import { describe, it, expect } from 'vitest';
import {
  DIRECT_CHOICE_LABEL,
  directChoiceHeadline,
  directExpertOwesChoice,
  type DirectRequestChoiceFacts,
} from './direct-request-choice';

const OWES: DirectRequestChoiceFacts = {
  onDirectLeg: true,
  relationshipStatus: 'eoi_submitted',
  availabilityShared: false,
  sentMessage: false,
};

describe('directExpertOwesChoice', () => {
  it('is true for the direct-leg expert at eoi_submitted who has not acted', () => {
    expect(directExpertOwesChoice(OWES)).toBe(true);
  });

  it('turns false once the expert shares availability', () => {
    expect(directExpertOwesChoice({ ...OWES, availabilityShared: true })).toBe(false);
  });

  it('turns false once the expert sends a message', () => {
    expect(directExpertOwesChoice({ ...OWES, sentMessage: true })).toBe(false);
  });

  it('is false off the direct leg (a match request, or an expert Balo invited alongside)', () => {
    expect(directExpertOwesChoice({ ...OWES, onDirectLeg: false })).toBe(false);
  });

  it.each(['invited', 'proposal_requested', 'proposal_submitted', 'accepted', 'declined'])(
    'is false at %s',
    (relationshipStatus) => {
      expect(directExpertOwesChoice({ ...OWES, relationshipStatus })).toBe(false);
    }
  );
});

describe('direct choice copy', () => {
  it('names the client party in the headline', () => {
    expect(directChoiceHeadline('Northwind')).toBe(
      'Northwind asked for you directly. Take it on, or pass?'
    );
    expect(DIRECT_CHOICE_LABEL).toBe('Take it on, or pass?');
  });
});
