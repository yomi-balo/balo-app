import { describe, it, expect } from 'vitest';
import { expertSettingsHrefFor, CHECKLIST_ITEMS, type ChecklistItemKey } from './expert-checklist';

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
