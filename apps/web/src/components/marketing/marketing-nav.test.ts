import { describe, it, expect } from 'vitest';
import { MARKETING_NAV_LINKS } from '@/lib/analytics';
import { MARKETING_NAV_ITEMS } from './marketing-nav';

describe('MARKETING_NAV_ITEMS', () => {
  it('every entry.key is a member of MARKETING_NAV_LINKS (drift guard)', () => {
    for (const entry of MARKETING_NAV_ITEMS) {
      expect(MARKETING_NAV_LINKS).toContain(entry.key);
    }
  });

  it('hrefs are exactly /experts and /expert/apply', () => {
    const hrefs = MARKETING_NAV_ITEMS.map((entry) => entry.href);
    expect(hrefs).toEqual(['/experts', '/expert/apply']);
  });

  it('has no duplicate keys', () => {
    const keys = MARKETING_NAV_ITEMS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe('find_experts.isActive', () => {
    const findExperts = MARKETING_NAV_ITEMS.find((entry) => entry.key === 'find_experts');

    it('is true for /experts and any nested expert profile', () => {
      expect(findExperts?.isActive('/experts')).toBe(true);
      expect(findExperts?.isActive('/experts/dana')).toBe(true);
    });

    it('is false for unrelated or lookalike paths', () => {
      expect(findExperts?.isActive('/dashboard')).toBe(false);
      expect(findExperts?.isActive('/expertsx')).toBe(false);
    });
  });

  describe('for_experts.isActive', () => {
    const forExperts = MARKETING_NAV_ITEMS.find((entry) => entry.key === 'for_experts');

    it('is false everywhere — the design reference gives it no active state', () => {
      expect(forExperts?.isActive('/expert/apply')).toBe(false);
      expect(forExperts?.isActive('/experts')).toBe(false);
      expect(forExperts?.isActive('/')).toBe(false);
    });
  });
});
