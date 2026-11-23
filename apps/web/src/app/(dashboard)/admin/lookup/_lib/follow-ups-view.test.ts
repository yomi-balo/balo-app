import { afterEach, describe, it, expect, vi } from 'vitest';
import { REMINDER_SEQUENCE_IDS } from '@balo/shared/notifications';
import {
  ANY_SEQUENCE_EXEMPT,
  EXEMPT_NOTE,
  FOOTNOTE,
  LIMIT_EXEMPT_TAIL,
  SEQUENCE_META,
  LOOKUP_FOLLOW_UP_TYPES,
  REASON_CODE,
  REASON_SENTENCE,
  hasFollowUpsTab,
  channelLabel,
  isFollowUpReasonKey,
  sequenceChannelLabel,
  type FollowUpReasonKey,
} from './follow-ups-view';

afterEach(() => {
  vi.doUnmock('@balo/shared/notifications');
  vi.resetModules();
});

describe('follow-ups wording', () => {
  it('has a code and a sentence for every reason', () => {
    const keys = Object.keys(REASON_SENTENCE) as FollowUpReasonKey[];
    expect(Object.keys(REASON_CODE).sort()).toEqual([...keys].sort());
  });

  it('says "today", never "24 hours", for the daily limit (decision 2)', () => {
    expect(REASON_SENTENCE.over_daily_limit('Dana', 0)).toBe(
      'Dana had already had two follow-up emails today.'
    );
    for (const key of Object.keys(REASON_SENTENCE) as FollowUpReasonKey[]) {
      expect(REASON_SENTENCE[key]('Dana', 3)).not.toMatch(/24 hours/i);
    }
  });

  it.each([
    [1, 'Dana had already had one follow-up email today.'],
    [3, 'Dana had already had three follow-up emails today.'],
    [9, 'Dana had already had 9 follow-up emails today.'],
  ])('derives the daily-limit wording from a limit of %i', async (limit, sentence) => {
    vi.resetModules();
    vi.doMock('@balo/shared/notifications', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@balo/shared/notifications')>()),
      REMINDER_DAILY_LIMIT: limit,
    }));
    const view = await import('./follow-ups-view');
    expect(view.REASON_SENTENCE.over_daily_limit('Dana', 0)).toBe(sentence);
  });

  it('says times are in the recipient’s zone, Melbourne when they have not set one', () => {
    expect(FOOTNOTE).toContain('recipient’s own time zone');
    expect(FOOTNOTE).toContain('Melbourne time when they haven’t set one');
  });

  it('pluralises attempts', () => {
    expect(REASON_SENTENCE.send_failed('Dana', 1)).toBe('It could not be sent after 1 attempt.');
    expect(REASON_SENTENCE.send_failed('Dana', 3)).toBe('It could not be sent after 3 attempts.');
  });

  it('shows no code line for a missed step, and the row status for a failed one', () => {
    expect(REASON_CODE.missed).toBeNull();
    expect(REASON_CODE.send_failed).toBe('status = failed');
  });

  it('knows reason keys by own property, not by prototype', () => {
    expect(isFollowUpReasonKey('over_daily_limit')).toBe(true);
    expect(isFollowUpReasonKey('already_decided')).toBe(false);
    expect(isFollowUpReasonKey('toString')).toBe(false);
    expect(isFollowUpReasonKey('')).toBe(false);
  });

  it('carries a Follow-ups tab on exactly the four types', () => {
    expect([...LOOKUP_FOLLOW_UP_TYPES]).toEqual([
      'user',
      'expert',
      'project_request',
      'engagement',
    ]);
    expect(hasFollowUpsTab('user')).toBe(true);
    expect(hasFollowUpsTab('company')).toBe(false);
    expect(hasFollowUpsTab('credit_session')).toBe(false);
  });
});

describe('per-sequence wording', () => {
  it('has complete wording for every registered sequence', () => {
    for (const id of REMINDER_SEQUENCE_IDS) {
      const meta = SEQUENCE_META[id];
      expect(meta.title).not.toBe('');
      expect(meta.aboutType).not.toBe('');
      expect(meta.untitled).not.toBe('');
      expect(meta.sinceLive).not.toBe('');
      expect(meta.sinceStopped).not.toBe('');
    }
  });

  it('takes the reference wording', () => {
    expect(SEQUENCE_META.delivery_review).toMatchObject({
      title: 'Work to review',
      aboutType: 'Engagement',
      untitled: 'A project',
      sinceLive: 'marked complete',
      endsAutomatically: true,
    });
    expect(SEQUENCE_META.invitation).toMatchObject({
      title: 'Invitation to answer',
      aboutType: 'Project request',
      sinceLive: 'invited',
      endsAutomatically: false,
    });
    expect(SEQUENCE_META.proposal_review).toMatchObject({
      sinceLive: 'waiting since',
      sinceStopped: 'began waiting',
      endsAutomatically: false,
    });
  });

  it('labels channels from the shared record, capitalised and joined', () => {
    expect(channelLabel(['email', 'in_app'])).toBe('Email and in-app');
    expect(sequenceChannelLabel('proposal_review')).toBe('Email');
    expect(sequenceChannelLabel('delivery_review')).toBe('Email and in-app');
    expect(sequenceChannelLabel('invitation')).toBe('Email');
  });

  it('words the exempt note and limit tail, without "24 hours"', () => {
    expect(EXEMPT_NOTE).toBe(
      'A deadline warning. Sent at its exact time and not counted in the daily limit.'
    );
    expect(LIMIT_EXEMPT_TAIL).toBe('Deadline warnings do not count.');
    expect(`${EXEMPT_NOTE}${LIMIT_EXEMPT_TAIL}`).not.toMatch(/24 hours/i);
    expect(ANY_SEQUENCE_EXEMPT).toBe(true);
  });
});
