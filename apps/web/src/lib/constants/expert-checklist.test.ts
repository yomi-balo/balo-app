import { describe, it, expect } from 'vitest';
import {
  expertSettingsHrefFor,
  expertSettingsTabFor,
  CHECKLIST_ITEMS,
  type ChecklistItemKey,
  type ExpertSettingsTabKey,
} from './expert-checklist';

/**
 * BAL-566 fix round 2 (W2) — a full table over every `ChecklistItemKey`, with explicit expected
 * literals (not a derived-and-compared assertion, which would pass even if the underlying
 * key→tab map were wrong in the same way on both sides). The length assertion below is the
 * non-vacuity guard: without it, a key silently dropped from this table would still pass.
 *
 * Mutation proof: change one key's tab in `CHECKLIST_TAB_BY_KEY` (`expert-checklist.ts`) — this
 * test fails on that key's row; restore.
 */
const EXPECTED_HREF_BY_KEY: Readonly<Record<ChecklistItemKey, string>> = {
  profile: '/expert/settings?tab=profile&setup=profile',
  phone: '/expert/settings?tab=profile&setup=phone',
  rate: '/expert/settings?tab=rate&setup=rate',
  calendar: '/expert/settings?tab=schedule&setup=calendar',
  availability: '/expert/settings?tab=schedule&setup=availability',
  payouts: '/expert/settings?tab=payouts&setup=payouts',
};

describe('expertSettingsHrefFor (BAL-566)', () => {
  it('builds the exact settings deep link for every checklist item key', () => {
    const keys = Object.keys(EXPECTED_HREF_BY_KEY) as ChecklistItemKey[];
    // Non-vacuity: the table must cover every declared checklist item, not a subset of it.
    expect(keys.length).toBe(CHECKLIST_ITEMS.length);
    for (const item of CHECKLIST_ITEMS) {
      expect(keys).toContain(item.key);
    }

    for (const key of keys) {
      expect(expertSettingsHrefFor(key)).toBe(EXPECTED_HREF_BY_KEY[key]);
    }
  });
});

/**
 * Explicit literals per key, same shape as the href table above: a derived-and-compared
 * assertion would pass with the underlying record wrong on both sides.
 */
const EXPECTED_TAB_BY_KEY: Readonly<Record<ChecklistItemKey, ExpertSettingsTabKey>> = {
  profile: 'profile',
  phone: 'profile',
  rate: 'rate',
  calendar: 'schedule',
  availability: 'schedule',
  payouts: 'payouts',
};

describe('expertSettingsTabFor', () => {
  it('names the settings tab every checklist item lives on', () => {
    const keys = Object.keys(EXPECTED_TAB_BY_KEY) as ChecklistItemKey[];
    expect(keys.length).toBe(CHECKLIST_ITEMS.length);

    for (const key of keys) {
      expect(expertSettingsTabFor(key)).toBe(EXPECTED_TAB_BY_KEY[key]);
    }
  });

  it('is the same tab the deep link carries', () => {
    for (const item of CHECKLIST_ITEMS) {
      expect(expertSettingsHrefFor(item.key)).toContain(`?tab=${expertSettingsTabFor(item.key)}&`);
    }
  });
});
