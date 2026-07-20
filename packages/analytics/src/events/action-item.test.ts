import { describe, it, expect } from 'vitest';
import { ACTION_ITEM_SERVER_EVENTS } from './action-item';

describe('ACTION_ITEM_SERVER_EVENTS', () => {
  it('exposes exactly the BAL-391 action-item server events', () => {
    expect(Object.keys(ACTION_ITEM_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'ASSIGNED',
      'COMPLETED',
      'CREATED',
      'EDITED',
      'REMOVED',
      'REOPENED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(ACTION_ITEM_SERVER_EVENTS.CREATED).toBe('action_item_created');
    expect(ACTION_ITEM_SERVER_EVENTS.ASSIGNED).toBe('action_item_assigned');
    expect(ACTION_ITEM_SERVER_EVENTS.COMPLETED).toBe('action_item_completed');
    expect(ACTION_ITEM_SERVER_EVENTS.REOPENED).toBe('action_item_reopened');
    expect(ACTION_ITEM_SERVER_EVENTS.EDITED).toBe('action_item_edited');
    expect(ACTION_ITEM_SERVER_EVENTS.REMOVED).toBe('action_item_removed');
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(ACTION_ITEM_SERVER_EVENTS)) {
      expect(value).toMatch(/^action_item_[a-z]+$/);
    }
  });
});
