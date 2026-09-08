import { describe, it, expect } from 'vitest';
import { ADMIN_LOOKUP_EVENTS } from './admin-lookup';

describe('ADMIN_LOOKUP_EVENTS', () => {
  it('has exactly the two admin lookup events', () => {
    expect(Object.keys(ADMIN_LOOKUP_EVENTS)).toEqual(['SEARCHED', 'OPENED']);
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(ADMIN_LOOKUP_EVENTS)) {
      expect(value).toMatch(/^admin_lookup_[a-z]+(_[a-z]+)*$/);
    }
  });

  it('maps constants to their exact event names', () => {
    expect(ADMIN_LOOKUP_EVENTS.SEARCHED).toBe('admin_lookup_searched');
    expect(ADMIN_LOOKUP_EVENTS.OPENED).toBe('admin_lookup_opened');
  });
});
