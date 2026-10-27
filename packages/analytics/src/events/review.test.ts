import { describe, it, expect } from 'vitest';
import { REVIEW_EVENTS, REVIEW_SERVER_EVENTS } from './review';

describe('REVIEW_SERVER_EVENTS', () => {
  it('exposes exactly the BAL-390 review server events', () => {
    expect(Object.keys(REVIEW_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'NUDGE_SENT',
      'SUBMITTED',
      'UPDATED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(REVIEW_SERVER_EVENTS.SUBMITTED).toBe('review_submitted');
    expect(REVIEW_SERVER_EVENTS.UPDATED).toBe('review_updated');
    expect(REVIEW_SERVER_EVENTS.NUDGE_SENT).toBe('review_nudge_sent');
  });

  it('uses snake_case event values', () => {
    for (const value of Object.values(REVIEW_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('prefixes every event with the feature noun, never the BAL-338 collision name', () => {
    for (const value of Object.values(REVIEW_SERVER_EVENTS)) {
      expect(value.startsWith('review_')).toBe(true);
      // `engagement_review_reminder_*` is BAL-338's pre-auto-accept nudge — a
      // different feature that must not be conflated with the star rating.
      expect(value).not.toContain('engagement_review');
    }
  });

  it('splits created from edited, so the write branches stay answerable', () => {
    expect(REVIEW_SERVER_EVENTS.SUBMITTED).not.toBe(REVIEW_SERVER_EVENTS.UPDATED);
  });
});

describe('REVIEW_EVENTS (BAL-587 / BAL-628 — the client namespace in this file)', () => {
  it('exposes exactly two client events', () => {
    expect(Object.keys(REVIEW_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'PREVIEW_OPENED',
      'PROMPT_VIEWED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(REVIEW_EVENTS.PROMPT_VIEWED).toBe('review_prompt_viewed');
    expect(REVIEW_EVENTS.PREVIEW_OPENED).toBe('review_preview_opened');
  });

  it('prefixes every event with the feature noun, never the BAL-338 collision name', () => {
    for (const name of Object.values(REVIEW_EVENTS)) {
      expect(name.startsWith('review_')).toBe(true);
      expect(name).not.toContain('engagement_review');
    }
  });
});
