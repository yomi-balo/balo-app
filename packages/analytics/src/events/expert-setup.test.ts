import { describe, it, expect } from 'vitest';
import { EXPERT_SETUP_EVENTS, EXPERT_SETUP_SERVER_EVENTS } from './expert-setup';

describe('EXPERT_SETUP_EVENTS (client)', () => {
  it('exposes exactly the two client setup events', () => {
    expect(Object.keys(EXPERT_SETUP_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'SETUP_ALL_COMPLETE',
      'SETUP_STEP_COMPLETED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(EXPERT_SETUP_EVENTS.SETUP_STEP_COMPLETED).toBe('expert_setup_step_completed');
    expect(EXPERT_SETUP_EVENTS.SETUP_ALL_COMPLETE).toBe('expert_setup_all_complete');
  });
});

describe('EXPERT_SETUP_SERVER_EVENTS (BAL-414, server-only)', () => {
  it('exposes exactly the one searchability server event', () => {
    expect(Object.keys(EXPERT_SETUP_SERVER_EVENTS)).toEqual(['SEARCHABILITY_CHANGED']);
  });

  it('maps the constant to its exact snake_case event name', () => {
    expect(EXPERT_SETUP_SERVER_EVENTS.SEARCHABILITY_CHANGED).toBe('expert_searchability_changed');
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
