import { describe, it, expect } from 'vitest';
import { ORG_INTENT_SERVER_EVENTS } from './org-intent';

describe('ORG_INTENT_SERVER_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(ORG_INTENT_SERVER_EVENTS)).toEqual(['CREATED_AT_INTENT']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(ORG_INTENT_SERVER_EVENTS.CREATED_AT_INTENT).toBe('org_created_at_intent');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(ORG_INTENT_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
