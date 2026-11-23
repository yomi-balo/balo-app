import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  REMINDER_SEQUENCE_AUDIENCE,
  REMINDER_SEQUENCE_CHANNELS,
  REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT,
  REMINDER_SEQUENCE_IDS,
  REMINDER_SEQUENCE_SHARED_RULES,
} from '@balo/shared/notifications';

vi.mock('@balo/db', () => ({}));

import { notificationRules } from '../engine/rules.js';

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

  it('names every channel its event rule delivers on, in-app written with an underscore', () => {
    for (const sequence of allReminderSequences()) {
      const ruleChannels = new Set(
        (notificationRules[sequence.event] ?? []).map((rule) => rule.channel.replace('-', '_'))
      );
      expect(new Set(sequence.channels)).toEqual(ruleChannels);
    }
  });

  it('registers delivery_review as a client reminder for engagement.review_reminder', () => {
    const sequence = REMINDER_SEQUENCES.delivery_review;
    expect(sequence.event).toBe('engagement.review_reminder');
    expect(sequence.channels).toEqual(['email', 'in_app']);
    expect(sequence.audience).toBe('client');
    expect(sequence.exemptFromDailyLimit).toBe(true);
  });

  it('finds a known id and not an unknown one', () => {
    expect(findReminderSequence('proposal_review')).toBe(REMINDER_SEQUENCES.proposal_review);
    expect(findReminderSequence('delivery_review')).toBe(REMINDER_SEQUENCES.delivery_review);
    expect(findReminderSequence('nope')).toBeUndefined();
    expect(findReminderSequence(undefined)).toBeUndefined();
  });

  it('takes the wait rule from the shared package', () => {
    const source = readFileSync(new URL('./proposal-review.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /import \{[^}]*proposalReviewWait[^}]*\} from '@balo\/shared\/project-requests'/
    );
    expect(source).not.toMatch(/function proposalAwaitsClientReview/);
    expect(source).not.toMatch(/function earliestSubmittedAt/);
  });

  it('names the shared wait rule in the sequence rule record', () => {
    expect(REMINDER_SEQUENCE_SHARED_RULES.proposal_review).toContain('proposalReviewWait');
  });

  it('takes every sequence daily-limit flag from the shared record', () => {
    for (const sequence of allReminderSequences()) {
      expect(sequence.exemptFromDailyLimit).toBe(
        REMINDER_SEQUENCE_EXEMPT_FROM_DAILY_LIMIT[sequence.id]
      );
    }
  });

  it('keeps one definition of the skip reasons, in the shared package', () => {
    const source = readFileSync(new URL('./recheck.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/export const REMINDER_SKIP_REASONS/);
    expect(source).toMatch(/type ReminderSkipReason[^}]*\} from '@balo\/shared\/notifications'/);
  });

  it('takes every sequence channel list and audience from the shared records', () => {
    for (const sequence of allReminderSequences()) {
      expect(sequence.channels).toEqual(REMINDER_SEQUENCE_CHANNELS[sequence.id]);
      expect(sequence.audience).toBe(REMINDER_SEQUENCE_AUDIENCE[sequence.id]);
    }
  });

  it('takes the delivery-review rule from the shared package', () => {
    const source = readFileSync(new URL('./delivery-review.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /import \{[^}]*deliveryReviewWait[^}]*\} from '@balo\/shared\/engagements'/
    );
    expect(source).not.toMatch(/function awaitsClientReview/);
  });

  it('names the shared wait rules in the delivery-review and invitation records', () => {
    expect(REMINDER_SEQUENCE_SHARED_RULES.delivery_review).toContain('deliveryReviewWait');
    expect(REMINDER_SEQUENCE_SHARED_RULES.invitation).toContain('invitationReminderWait');
  });

  it('takes the invitation rule from the shared package and declares no copy', () => {
    const source = readFileSync(new URL('./invitation.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /import \{[^}]*invitationReminderWait[^}]*\} from '@balo\/shared\/project-requests'/
    );
    expect(source).not.toMatch(/function expertInvitationMove/);
    expect(source).not.toMatch(/budget|price|fee/i);
  });
});
