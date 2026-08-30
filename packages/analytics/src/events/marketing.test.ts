import { describe, it, expect } from 'vitest';
import { MARKETING_EVENTS, MARKETING_NAV_LINKS, MARKETING_SURFACES } from './marketing';

describe('MARKETING_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(MARKETING_EVENTS)).toEqual([
      'NAV_CLICKED',
      'DASHBOARD_CLICKED',
      'GET_STARTED_CLICKED',
    ]);
  });

  it('maps each constant to its exact snake_case value', () => {
    expect(MARKETING_EVENTS.NAV_CLICKED).toBe('marketing_nav_clicked');
    expect(MARKETING_EVENTS.DASHBOARD_CLICKED).toBe('marketing_dashboard_clicked');
    expect(MARKETING_EVENTS.GET_STARTED_CLICKED).toBe('marketing_get_started_clicked');
  });

  it('values follow the naming convention {feature}_{noun}_{past_tense_verb}', () => {
    for (const value of Object.values(MARKETING_EVENTS)) {
      expect(value).toMatch(/^marketing_[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('MARKETING_NAV_LINKS', () => {
  it('is the exact pinned tuple, in order', () => {
    expect(MARKETING_NAV_LINKS).toEqual(['find_experts', 'for_experts', 'how_it_works', 'pricing']);
  });

  it('has 4 entries with no duplicates', () => {
    expect(MARKETING_NAV_LINKS.length).toBe(4);
    expect(new Set(MARKETING_NAV_LINKS).size).toBe(4);
  });
});

describe('MARKETING_SURFACES', () => {
  it('is the exact pinned tuple, in order', () => {
    expect(MARKETING_SURFACES).toEqual(['header', 'mobile_menu']);
  });
});
