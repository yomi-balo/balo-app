import { describe, it, expect } from 'vitest';
import { MARKETING_NAV_LINKS } from '@/lib/analytics';
import { MARKETING_NAV_ITEMS } from './marketing-nav';

describe('MARKETING_NAV_ITEMS', () => {
  it('every entry.key is a member of MARKETING_NAV_LINKS (drift guard)', () => {
    for (const entry of MARKETING_NAV_ITEMS) {
      expect(MARKETING_NAV_LINKS).toContain(entry.key);
    }
  });

  it('is the design reference’s four links, in its order, with their hrefs', () => {
    expect(MARKETING_NAV_ITEMS.map((entry) => [entry.key, entry.label, entry.href])).toEqual([
      ['find_experts', 'Find experts', '/experts'],
      ['how_it_works', 'How it works', '/how-it-works'],
      ['for_experts', 'For experts', '/for-experts'],
      ['pricing', 'Pricing', '/pricing'],
    ]);
  });

  it('For experts never sends a visitor to the expert application', () => {
    const forExperts = MARKETING_NAV_ITEMS.find((entry) => entry.key === 'for_experts');
    expect(forExperts?.href).not.toMatch(/^\/expert\/apply/);
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

  describe.each(['how_it_works', 'for_experts', 'pricing'] as const)('%s.isActive', (key) => {
    const entry = MARKETING_NAV_ITEMS.find((item) => item.key === key);

    it('is false everywhere, its own page included — only Find experts has an active state', () => {
      expect(entry?.isActive(entry.href)).toBe(false);
      expect(entry?.isActive('/experts')).toBe(false);
      expect(entry?.isActive('/')).toBe(false);
    });
  });
});
