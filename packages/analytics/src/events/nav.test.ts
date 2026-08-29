import { describe, it, expect } from 'vitest';
import { NAV_EVENTS, NAV_ITEM_KEYS, NAV_SURFACES } from './nav';

describe('NAV_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(NAV_EVENTS)).toEqual(['ITEM_CLICKED']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(NAV_EVENTS.ITEM_CLICKED).toBe('nav_item_clicked');
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
      'consultations',
      'projects',
      'calendar',
      'messages',
      'expert_settings',
      'team',
      'account',
      'help',
    ]);
  });

  it('has 10 entries with no duplicates', () => {
    expect(NAV_ITEM_KEYS.length).toBe(10);
    expect(new Set(NAV_ITEM_KEYS).size).toBe(10);
  });
});

describe('NAV_SURFACES', () => {
  it('is the exact pinned tuple, in order', () => {
    expect(NAV_SURFACES).toEqual(['sidebar', 'bottom_tabs', 'command_palette']);
  });
});
