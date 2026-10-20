import { describe, it, expect } from 'vitest';
import {
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
});
