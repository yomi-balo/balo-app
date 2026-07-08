import { describe, it, expect } from 'vitest';
import { ENGAGEMENT_SERVER_EVENTS } from './engagement';

describe('ENGAGEMENT_SERVER_EVENTS', () => {
  it('exposes the workspace-viewed + three BAL-332 milestone-transition server events', () => {
    expect(Object.keys(ENGAGEMENT_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'MILESTONE_COMPLETED',
      'MILESTONE_REVERTED',
      'MILESTONE_STARTED',
      'WORKSPACE_VIEWED',
    ]);
  });

  it('maps each milestone constant to its exact snake_case event name', () => {
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_STARTED).toBe('engagement_milestone_started');
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_COMPLETED).toBe('engagement_milestone_completed');
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_REVERTED).toBe('engagement_milestone_reverted');
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(ENGAGEMENT_SERVER_EVENTS)) {
      expect(value).toMatch(/^engagement_[a-z]+(_[a-z]+)*$/);
    }
  });
});
