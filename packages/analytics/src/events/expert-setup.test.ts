import { describe, it, expect } from 'vitest';
import { EXPERT_SETUP_EVENTS, EXPERT_SETUP_SERVER_EVENTS } from './expert-setup';

describe('EXPERT_SETUP_EVENTS (client)', () => {
  it('exposes exactly the four client setup events', () => {
    expect(Object.keys(EXPERT_SETUP_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'LIVE_STATUS_ACTION',
      'LIVE_STATUS_OPENED',
      'SETUP_ALL_COMPLETE',
      'SETUP_STEP_COMPLETED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(EXPERT_SETUP_EVENTS.SETUP_STEP_COMPLETED).toBe('expert_setup_step_completed');
    expect(EXPERT_SETUP_EVENTS.SETUP_ALL_COMPLETE).toBe('expert_setup_all_complete');
    expect(EXPERT_SETUP_EVENTS.LIVE_STATUS_OPENED).toBe('expert_live_status_opened');
    expect(EXPERT_SETUP_EVENTS.LIVE_STATUS_ACTION).toBe('expert_live_status_action');
  });
});

describe('EXPERT_SETUP_SERVER_EVENTS (BAL-414, server-only)', () => {
  it('exposes exactly the searchability and celebration server events', () => {
    expect(Object.keys(EXPERT_SETUP_SERVER_EVENTS)).toEqual([
      'SEARCHABILITY_CHANGED',
      'LIVE_CELEBRATION_VIEWED',
    ]);
  });

  it('maps the constant to its exact snake_case event name', () => {
    expect(EXPERT_SETUP_SERVER_EVENTS.SEARCHABILITY_CHANGED).toBe('expert_searchability_changed');
    expect(EXPERT_SETUP_SERVER_EVENTS.LIVE_CELEBRATION_VIEWED).toBe(
      'expert_live_celebration_viewed'
    );
  });

  it('uses snake_case event values for both maps', () => {
    for (const value of [
      ...Object.values(EXPERT_SETUP_EVENTS),
      ...Object.values(EXPERT_SETUP_SERVER_EVENTS),
    ]) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
