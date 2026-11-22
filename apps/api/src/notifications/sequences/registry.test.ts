import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { REMINDER_SEQUENCE_IDS } from '@balo/shared/notifications';

vi.mock('@balo/db', () => ({}));

import {
  REMINDER_SEQUENCES,
  allReminderSequences,
  findReminderSequence,
  limitedSequencePrefixes,
} from './registry.js';

describe('REMINDER_SEQUENCES', () => {
  it('has exactly the ids the shared table lists, each under its own id', () => {
    expect(Object.keys(REMINDER_SEQUENCES).sort((a, b) => a.localeCompare(b))).toEqual(
      [...REMINDER_SEQUENCE_IDS].sort((a, b) => a.localeCompare(b))
    );
    for (const sequence of allReminderSequences()) {
      expect(REMINDER_SEQUENCES[sequence.id]).toBe(sequence);
    }
  });

  it('limits every non-exempt sequence by its key prefix', () => {
    expect(limitedSequencePrefixes()).toEqual(['seq:proposal_review:', 'seq:invitation:']);
  });

  it('finds a known id and not an unknown one', () => {
    expect(findReminderSequence('proposal_review')).toBe(REMINDER_SEQUENCES.proposal_review);
    expect(findReminderSequence('nope')).toBeUndefined();
    expect(findReminderSequence(undefined)).toBeUndefined();
  });

  it('takes the awaiting-review rule from the shared package', () => {
    const source = readFileSync(new URL('./proposal-review.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /import \{[^}]*proposalAwaitsClientReview[^}]*\} from '@balo\/shared\/project-requests'/
    );
    expect(source).not.toMatch(/function proposalAwaitsClientReview/);
  });

  it('takes the invitation rule from the shared package and declares no copy', () => {
    const source = readFileSync(new URL('./invitation.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /import \{[^}]*expertInvitationMove[^}]*\} from '@balo\/shared\/project-requests'/
    );
    expect(source).not.toMatch(/function expertInvitationMove/);
    expect(source).not.toMatch(/budget|price|fee/i);
  });
});
