import { describe, it, expect } from 'vitest';
import { ENGAGEMENT_SERVER_EVENTS } from './engagement';

describe('ENGAGEMENT_SERVER_EVENTS', () => {
  it('exposes workspace-viewed + the BAL-332 transition + BAL-333 scope-edit server events', () => {
    expect(Object.keys(ENGAGEMENT_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'MILESTONE_ADDED',
      'MILESTONE_COMPLETED',
      'MILESTONE_EDITED',
      'MILESTONE_REMOVED',
      'MILESTONE_REVERTED',
      'MILESTONE_STARTED',
      'WORKSPACE_VIEWED',
    ]);
  });

  it('maps each milestone constant to its exact snake_case event name', () => {
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_STARTED).toBe('engagement_milestone_started');
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_COMPLETED).toBe('engagement_milestone_completed');
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_REVERTED).toBe('engagement_milestone_reverted');
    // BAL-333 scope-edit events.
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_ADDED).toBe('engagement_milestone_added');
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_EDITED).toBe('engagement_milestone_edited');
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_REMOVED).toBe('engagement_milestone_removed');
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(ENGAGEMENT_SERVER_EVENTS)) {
      expect(value).toMatch(/^engagement_[a-z]+(_[a-z]+)*$/);
    }
  });
});
