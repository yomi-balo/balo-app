import { describe, expect, it } from 'vitest';
import { CALL_TOAST_COPY, formatMissedTime } from './call-toast-copy';

describe('CALL_TOAST_COPY', () => {
  it('matches the copy sheet for the toast surfaces', () => {
    expect(CALL_TOAST_COPY.incomingTitle('Sandy')).toBe('Sandy is calling');
    expect(CALL_TOAST_COPY.incomingAbout('Flow migration')).toBe('About Flow migration.');
    expect(CALL_TOAST_COPY.missedTitle('Sandy')).toBe('You missed a call from Sandy');
    expect(CALL_TOAST_COPY.missedTitleMany(2, 'Sandy')).toBe('2 missed calls from Sandy');
    expect(CALL_TOAST_COPY.missedBody('3:05 pm')).toBe('They tried to reach you at 3:05 pm.');
    expect(CALL_TOAST_COPY.callBack).toBe('Call back');
    expect(CALL_TOAST_COPY.browserTitle('Sandy')).toBe('Sandy is calling');
    expect(CALL_TOAST_COPY.browserBody('Flow migration')).toBe(
      'Flow migration. Open Balo to join.'
    );
  });

  it('keeps the browser body sensible without a case title', () => {
    expect(CALL_TOAST_COPY.browserBody(null)).toBe('Open Balo to join.');
  });

  it('names the call in the Join label without gendered wording', () => {
    expect(CALL_TOAST_COPY.joinAriaLabel('Sandy')).toBe('Join Sandy’s call');
  });
});

describe('formatMissedTime', () => {
  it('formats a local h:mm time', () => {
    expect(formatMissedTime('2026-11-19T15:05:00.000Z', 'en-US')).toMatch(/^\d{1,2}:05\s?[AP]M$/);
  });

  it('is empty for an unreadable instant', () => {
    expect(formatMissedTime('nope')).toBe('');
  });
});
