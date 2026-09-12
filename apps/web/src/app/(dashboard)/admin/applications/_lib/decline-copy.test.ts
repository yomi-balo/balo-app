import { describe, it, expect } from 'vitest';
import { EXPERT_DECLINE_REASONS } from '@balo/shared/experts';
import {
  DECLINE_NOTE_MIN_LENGTH,
  DECLINE_REASONS,
  DECLINE_REASON_LABEL,
  declineNotePlaceholderFor,
} from './decline-copy';

describe('DECLINE_REASONS', () => {
  it('has exactly one card per EXPERT_DECLINE_REASONS member, in order', () => {
    expect(DECLINE_REASONS.map((r) => r.key)).toEqual([...EXPERT_DECLINE_REASONS]);
  });

  it('every card has a non-empty label and hint', () => {
    for (const reason of DECLINE_REASONS) {
      expect(reason.label.length).toBeGreaterThan(0);
      expect(reason.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('DECLINE_REASON_LABEL', () => {
  it('has a label for every EXPERT_DECLINE_REASONS member', () => {
    expect(Object.keys(DECLINE_REASON_LABEL).sort()).toEqual([...EXPERT_DECLINE_REASONS].sort());
  });
});

describe('DECLINE_NOTE_MIN_LENGTH', () => {
  /**
   * FIX ROUND F14 — RETITLED. This asserts the CONSTANT'S VALUE and nothing else; it reads
   * nothing from the Server Action, so it never proved the two agreed (raising the action's
   * `.min()` left it green). The agreement is now STRUCTURAL — `decline-expert-application.ts`
   * imports this constant — and is pinned end-to-end in that action's own suite.
   */
  it('is 8 — a sentence, not a word', () => {
    expect(DECLINE_NOTE_MIN_LENGTH).toBe(8);
  });
});

describe('declineNotePlaceholderFor', () => {
  it('names the applicant and states the note is never shown to them', () => {
    const placeholder = declineNotePlaceholderFor('Priya');
    expect(placeholder).toContain('Priya');
    expect(placeholder.toLowerCase()).toContain('never shown');
  });
});
