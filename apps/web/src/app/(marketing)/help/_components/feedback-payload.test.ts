import { describe, expect, it } from 'vitest';
import { toFeedbackPayload } from './feedback-payload';

describe('toFeedbackPayload', () => {
  it('sends no comment for a helpful verdict, even if text is passed', () => {
    expect(toFeedbackPayload('g', true, 'ignored')).toEqual({
      slug: 'g',
      helpful: true,
      has_comment: false,
    });
  });

  it('trims the comment of an unhelpful verdict', () => {
    expect(toFeedbackPayload('g', false, '  x  ')).toEqual({
      slug: 'g',
      helpful: false,
      has_comment: true,
      comment: 'x',
    });
  });

  it('omits the comment key when the note is missing or blank', () => {
    expect(toFeedbackPayload('g', false)).not.toHaveProperty('comment');
    const blank = toFeedbackPayload('g', false, '   ');
    expect(blank).not.toHaveProperty('comment');
    expect(blank.has_comment).toBe(false);
  });

  it('caps the comment at 1,000 characters', () => {
    expect(toFeedbackPayload('g', false, 'a'.repeat(1200)).comment).toHaveLength(1000);
  });
});
