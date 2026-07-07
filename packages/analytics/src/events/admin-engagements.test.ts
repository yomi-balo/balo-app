import { describe, it, expect } from 'vitest';
import { ADMIN_ENGAGEMENTS_EVENTS } from './admin-engagements';

describe('ADMIN_ENGAGEMENTS_EVENTS', () => {
  it('has exactly the one admin engagements oversight event', () => {
    expect(Object.keys(ADMIN_ENGAGEMENTS_EVENTS)).toEqual(['LIST_VIEWED']);
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(ADMIN_ENGAGEMENTS_EVENTS)) {
      expect(value).toMatch(/^admin_engagements_[a-z]+(_[a-z]+)*$/);
    }
  });

  it('maps constants to their exact event names', () => {
    expect(ADMIN_ENGAGEMENTS_EVENTS.LIST_VIEWED).toBe('admin_engagements_list_viewed');
  });
});
