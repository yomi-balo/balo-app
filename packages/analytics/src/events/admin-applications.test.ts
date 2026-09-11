import { describe, it, expect } from 'vitest';
import { ADMIN_APPLICATIONS_EVENTS } from './admin-applications';

describe('ADMIN_APPLICATIONS_EVENTS', () => {
  it('has exactly the two admin applications events', () => {
    expect(Object.keys(ADMIN_APPLICATIONS_EVENTS)).toEqual(['REVIEWED', 'LIST_VIEWED']);
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(ADMIN_APPLICATIONS_EVENTS)) {
      expect(value).toMatch(/^admin_applications_[a-z]+(_[a-z]+)*$/);
    }
  });

  it('maps constants to their exact event names', () => {
    expect(ADMIN_APPLICATIONS_EVENTS.REVIEWED).toBe('admin_applications_reviewed');
    expect(ADMIN_APPLICATIONS_EVENTS.LIST_VIEWED).toBe('admin_applications_list_viewed');
  });
});
