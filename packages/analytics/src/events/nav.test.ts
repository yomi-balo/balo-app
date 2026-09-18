import { describe, it, expect } from 'vitest';
import { NAV_EVENTS, NAV_ITEM_KEYS, NAV_SURFACES } from './nav';

describe('NAV_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(NAV_EVENTS)).toEqual(['ITEM_CLICKED', 'MORE_OPENED']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(NAV_EVENTS.ITEM_CLICKED).toBe('nav_item_clicked');
    expect(NAV_EVENTS.MORE_OPENED).toBe('nav_more_opened');
  });

  it('values follow the naming convention {feature}_{noun}_{past_tense_verb}', () => {
    for (const value of Object.values(NAV_EVENTS)) {
      expect(value).toMatch(/^nav_[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('NAV_ITEM_KEYS', () => {
  it('is the exact pinned tuple, in order', () => {
    expect(NAV_ITEM_KEYS).toEqual([
      'dashboard',
      'find_experts',
      // ⚠ BAL-567 — renamed in place from `consultations`; position and count are unchanged.
      'cases',
      'projects',
      'calendar',
      'messages',
      'expert_settings',
      'settings',
      'team',
      'account',
      'help',
      'admin_home',
      'admin_applications',
      'admin_engagements',
      'admin_promo_codes',
      'admin_catalogue',
      'admin_lookup',
      'admin_health',
      'admin_staff_access',
    ]);
  });

  it('has 19 entries with no duplicates', () => {
    expect(NAV_ITEM_KEYS.length).toBe(19);
    expect(new Set(NAV_ITEM_KEYS).size).toBe(19);
  });

  /**
   * BAL-567 — the OLD key is gone, not aliased.
   *
   * ⚠ WITHOUT THIS, "renamed in place" and "added beside" look identical to the tuple assertion
   * above the moment someone re-adds `consultations` "for continuity". Two keys for one nav item
   * is the drift this tuple exists to prevent, and it would also make the count 20 — which the
   * assertion above would catch, but only after someone had already written the alias.
   */
  it('BAL-567 — no longer declares the retired `consultations` key', () => {
    expect(NAV_ITEM_KEYS).not.toContain('consultations');
    expect(NAV_ITEM_KEYS).toContain('cases');
  });
});

describe('NAV_SURFACES', () => {
  it('is the exact pinned tuple, in order', () => {
    expect(NAV_SURFACES).toEqual(['sidebar', 'bottom_tabs', 'more_sheet', 'command_palette']);
  });
});
