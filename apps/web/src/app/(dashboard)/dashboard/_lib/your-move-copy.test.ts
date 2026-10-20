import { describe, it, expect } from 'vitest';
import { KICKOFF_MEMBER_BLOCKED_SUB } from '@/components/balo/project-request/proposal/kickoff-board';
import {
  YOUR_MOVE_DATED_FACT,
  YOUR_MOVE_KICKOFF_MEMBER_NOTE,
  yourMoveAboutWeeks,
  yourMoveExpertCounterparty,
  yourMoveJoinTitle,
  yourMoveRelFact,
  yourMoveReviewProposalsAction,
  yourMoveSentFact,
  yourMoveSinceFact,
  YOUR_MOVE_SECTION_LABELS,
  yourMoveCompaniesSentence,
  yourMoveCountSentence,
  yourMoveEoiSentence,
  yourMoveUnreadTitle,
} from './your-move-copy';

describe('your-move copy', () => {
  it('counts one and many', () => {
    expect(yourMoveCountSentence(1)).toBe('1 thing is waiting on you');
    expect(yourMoveCountSentence(3)).toBe('3 things are waiting on you');
  });

  it('joins company names', () => {
    expect(yourMoveCompaniesSentence([])).toBe('');
    expect(yourMoveCompaniesSentence(['A'])).toBe('A');
    expect(yourMoveCompaniesSentence(['A', 'B'])).toBe('A and B');
    expect(yourMoveCompaniesSentence(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more');
  });

  it('pluralises the unread title', () => {
    expect(yourMoveUnreadTitle(1, 1)).toBe('1 unread in 1 conversation');
    expect(yourMoveUnreadTitle(4, 2)).toBe('4 unread in 2 conversations');
  });

  it('names the company in the intro-call sentence', () => {
    expect(yourMoveEoiSentence('Orbit Media')).toBe(
      'Share your availability so Orbit Media can book an intro call.'
    );
  });

  it('shows no section chip for a general change request', () => {
    expect(YOUR_MOVE_SECTION_LABELS.general).toBeNull();
    expect(YOUR_MOVE_SECTION_LABELS.pricing).toBe('Pricing');
  });

  it('keeps the kickoff member note identical to the kickoff board notice', () => {
    expect(YOUR_MOVE_KICKOFF_MEMBER_NOTE).toBe(KICKOFF_MEMBER_BLOCKED_SUB);
  });

  it('words the client facts', () => {
    expect(yourMoveSentFact('yesterday')).toBe('Sent yesterday');
    expect(yourMoveSinceFact('2 days ago')).toBe('Since 2 days ago');
    expect(yourMoveRelFact('yesterday')).toBe('Yesterday');
    expect(yourMoveReviewProposalsAction(3)).toBe('Review 3 proposals');
    expect(yourMoveJoinTitle(1)).toBe('1 person asked to join');
    expect(yourMoveJoinTitle(3)).toBe('3 people asked to join');
    expect(yourMoveAboutWeeks(1)).toBe('About 1 week');
    expect(yourMoveAboutWeeks(6)).toBe('About 6 weeks');
    expect(YOUR_MOVE_DATED_FACT.reply_by('Thu 22 Oct')).toBe('Reply by Thu 22 Oct');
  });

  it('names the expert as person and agency', () => {
    expect(
      yourMoveExpertCounterparty({ personName: 'Maya Patel', agencyLabel: 'Brightline' })
    ).toBe('Maya Patel, Brightline');
    expect(yourMoveExpertCounterparty({ personName: 'Sam Rivera', agencyLabel: null })).toBe(
      'Sam Rivera'
    );
  });
});
