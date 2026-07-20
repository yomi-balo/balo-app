import { describe, it, expect } from 'vitest';
import { TRANSCRIPT_SERVER_EVENTS } from './transcript';

describe('TRANSCRIPT_SERVER_EVENTS', () => {
  it('exposes exactly the BAL-387 transcript server events', () => {
    expect(Object.keys(TRANSCRIPT_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'BOT_JOIN_FAILED',
      'SUMMARY_READY',
      'TRANSCRIPT_READY',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(TRANSCRIPT_SERVER_EVENTS.BOT_JOIN_FAILED).toBe('bot_join_failed');
    expect(TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_READY).toBe('transcript_ready');
    expect(TRANSCRIPT_SERVER_EVENTS.SUMMARY_READY).toBe('summary_ready');
  });

  it('uses snake_case event values', () => {
    for (const value of Object.values(TRANSCRIPT_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
