import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  FOOTNOTE,
  LOOKUP_FOLLOW_UP_TYPES,
  REASON_CODE,
  REASON_SENTENCE,
  hasFollowUpsTab,
  isFollowUpReasonKey,
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
