import { describe, it, expect } from 'vitest';
import {
  MARKETING_HOME_BENCH_ROWS,
  MARKETING_HOME_CTA_PLACEMENTS,
  MARKETING_HOME_EVENTS,
  MARKETING_HOME_PRODUCT_SOURCES,
  MARKETING_HOME_SECTIONS,
  MARKETING_HOME_SPOTLIGHT_ACTIONS,
} from './marketing-home';

/**
 * BAL-493 — the exact-key-set guard for the home page's event family (template:
 * `marketing.test.ts`). Run with `pnpm vitest run --project packages/analytics` from the repo
 * root: `@balo/analytics` has NO `test` script and `turbo.json` has no `test` task, so
 * `turbo run test` silently does nothing for this package.
 */
describe('MARKETING_HOME_EVENTS', () => {
  it('has exactly the expected keys, in order', () => {
    expect(Object.keys(MARKETING_HOME_EVENTS)).toEqual([
      'HERO_SEARCH_SUBMITTED',
      'HERO_FACET_OPENED',
      'HERO_PRODUCT_TOGGLED',
      'PRODUCT_TILE_CLICKED',
      'SPOTLIGHT_EXPERT_CLICKED',
      'CTA_CLICKED',
      'SECTION_VIEWED',
    ]);
  });

  it('maps each constant to its exact snake_case value', () => {
    expect(MARKETING_HOME_EVENTS.HERO_SEARCH_SUBMITTED).toBe(
      'marketing_home_hero_search_submitted'
    );
    expect(MARKETING_HOME_EVENTS.HERO_FACET_OPENED).toBe('marketing_home_hero_facet_opened');
    expect(MARKETING_HOME_EVENTS.HERO_PRODUCT_TOGGLED).toBe('marketing_home_hero_product_toggled');
    expect(MARKETING_HOME_EVENTS.PRODUCT_TILE_CLICKED).toBe('marketing_home_product_tile_clicked');
    expect(MARKETING_HOME_EVENTS.SPOTLIGHT_EXPERT_CLICKED).toBe(
      'marketing_home_spotlight_expert_clicked'
    );
    expect(MARKETING_HOME_EVENTS.CTA_CLICKED).toBe('marketing_home_cta_clicked');
    expect(MARKETING_HOME_EVENTS.SECTION_VIEWED).toBe('marketing_home_section_viewed');
  });

  it('values all carry the marketing_home_ prefix and the naming convention', () => {
    for (const value of Object.values(MARKETING_HOME_EVENTS)) {
      expect(value).toMatch(/^marketing_home_[a-z]+(_[a-z]+)*$/);
    }
  });

  it('shares no value with the marketing CHROME family it is deliberately split from', () => {
    const values = Object.values(MARKETING_HOME_EVENTS);
    expect(values).not.toContain('marketing_nav_clicked');
    expect(values).not.toContain('marketing_dashboard_clicked');
    expect(values).not.toContain('marketing_get_started_clicked');
  });
});

describe('MARKETING_HOME_SECTIONS', () => {
  it('is the exact pinned tuple, in page order (these are also the anchor ids)', () => {
    expect(MARKETING_HOME_SECTIONS).toEqual([
      'hero',
      'proof',
      'ways',
      'how-it-works',
      'experts',
      'pricing',
      'for-experts',
      'testimonials',
      'final',
    ]);
  });

  it('has 9 entries with no duplicates', () => {
    expect(MARKETING_HOME_SECTIONS.length).toBe(9);
    expect(new Set(MARKETING_HOME_SECTIONS).size).toBe(9);
  });
});

describe('MARKETING_HOME_CTA_PLACEMENTS', () => {
  it('is the exact pinned tuple, in order', () => {
    expect(MARKETING_HOME_CTA_PLACEMENTS).toEqual(['ways', 'experts', 'band', 'final']);
  });

  it('has 4 entries with no duplicates', () => {
    expect(MARKETING_HOME_CTA_PLACEMENTS.length).toBe(4);
    expect(new Set(MARKETING_HOME_CTA_PLACEMENTS).size).toBe(4);
  });

  /**
   * ⚠ THE DOUBLE-FIRE GUARD IS A TEST, NOT A COMMENT. The header already dispatches
   * `MARKETING_EVENTS.NAV_CLICKED` through `useMarketingTracking` — the ONE dispatch point for
   * the marketing chrome. A `'nav'` placement here would emit a SECOND event for ONE click and
   * silently double-count the page's conversion funnel.
   */
  it("does NOT contain 'nav' — the chrome already emits NAV_CLICKED for that click", () => {
    expect(MARKETING_HOME_CTA_PLACEMENTS).not.toContain('nav');
  });

  /** `'hero'` and `'pricing'` are absent because NO EMITTER EXISTS — see the union's docblock. */
  it('declares no placement without a live emitter', () => {
    expect(MARKETING_HOME_CTA_PLACEMENTS).not.toContain('hero');
    expect(MARKETING_HOME_CTA_PLACEMENTS).not.toContain('pricing');
  });
});

describe('MARKETING_HOME_BENCH_ROWS', () => {
  it('is the exact pinned tuple, in order', () => {
    expect(MARKETING_HOME_BENCH_ROWS).toEqual(['a', 'b']);
  });
});

describe('MARKETING_HOME_PRODUCT_SOURCES', () => {
  it('is the exact pinned tuple, in order', () => {
    expect(MARKETING_HOME_PRODUCT_SOURCES).toEqual(['facet', 'chip']);
  });
});

describe('MARKETING_HOME_SPOTLIGHT_ACTIONS', () => {
  it('is the exact pinned tuple, in order', () => {
    expect(MARKETING_HOME_SPOTLIGHT_ACTIONS).toEqual(['profile', 'book']);
  });
});
