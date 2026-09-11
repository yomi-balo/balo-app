import { describe, it, expect } from 'vitest';
import type { AdminLookupEventMap } from './admin-lookup';
import { ADMIN_LOOKUP_EVENTS } from './admin-lookup';

describe('ADMIN_LOOKUP_EVENTS', () => {
  it('has exactly the three admin lookup events', () => {
    expect(Object.keys(ADMIN_LOOKUP_EVENTS)).toEqual(['SEARCHED', 'OPENED', 'TAB_SELECTED']);
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(ADMIN_LOOKUP_EVENTS)) {
      expect(value).toMatch(/^admin_lookup_[a-z]+(_[a-z]+)*$/);
    }
  });

  it('maps constants to their exact event names', () => {
    expect(ADMIN_LOOKUP_EVENTS.SEARCHED).toBe('admin_lookup_searched');
    expect(ADMIN_LOOKUP_EVENTS.OPENED).toBe('admin_lookup_opened');
    expect(ADMIN_LOOKUP_EVENTS.TAB_SELECTED).toBe('admin_lookup_tab_selected');
  });

  it('the AdminLookupEventMap entry for TAB_SELECTED compiles with entity_type + tab', () => {
    const payload: AdminLookupEventMap[typeof ADMIN_LOOKUP_EVENTS.TAB_SELECTED] = {
      entity_type: 'engagement',
      tab: 'timeline',
    };
    expect(payload.tab).toBe('timeline');
  });
});
