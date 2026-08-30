/**
 * BAL-493 — the marketing HOME PAGE's CLIENT event family (the logged-out `/` surface).
 *
 * ⚠ Deliberately SEPARATE from `MARKETING_EVENTS` (`./marketing.ts`), which is the marketing
 * CHROME's family. `MARKETING_SURFACES = ['header','mobile_menu']` is the chrome's vocabulary,
 * types all three of its events and is pinned by an exact-tuple test; widening it with page
 * sections would retroactively change what a historical `marketing_nav_clicked{surface}` means.
 * The seven events below are page-CONTENT events with entirely different property shapes — they
 * share nothing with the chrome family but a word. `marketing.ts:2-8` sets this precedent
 * explicitly for its own split from `nav.ts`, for exactly this "do not widen a pinned tuple"
 * reason.
 *
 * Values all carry the `marketing_home_` prefix, so the family's guard regex is
 * `/^marketing_home_[a-z]+(_[a-z]+)*$/`.
 *
 * PRIVACY: the hero search emits `query_length`, NEVER the query text (the discipline
 * `composer-analytics.ts` already states verbatim). Product values are public taxonomy NAMES,
 * not UUIDs — a UUID is unreadable in PostHog, and taxonomy terms are non-sensitive and
 * valuable for supply recruiting. `expert_id` is an internal uuid already emitted by
 * `search_result_clicked` and `expert_profile_viewed`.
 */

/**
 * ⚠ THE CANONICAL SECTION TUPLE — it doubles as the page's SECTION ANCHOR IDS. `page.tsx`
 * renders `id={section}` from this same tuple that types `section_viewed`, so a rendered
 * anchor and an analytics value cannot drift (the discipline `marketing-nav.ts` applies to
 * `MARKETING_NAV_LINKS`).
 */
export const MARKETING_HOME_SECTIONS = [
  'hero',
  'proof',
  'ways',
  'how-it-works',
  'experts',
  'pricing',
  'for-experts',
  'testimonials',
  'final',
] as const;
export type MarketingHomeSection = (typeof MARKETING_HOME_SECTIONS)[number];

/**
 * Where on the home page a CTA was activated.
 *
 * ⚠ THREE PLACEMENTS ARE DELIBERATELY ABSENT, and the omissions are load-bearing:
 *
 * - `'nav'` — the header is `MarketingHeader`, which already dispatches through
 *   `useMarketingTracking`, "the ONE dispatch point for the marketing chrome's three events".
 *   A nav-placement `cta_clicked` would be a SECOND event for ONE click.
 *   `MARKETING_EVENTS.NAV_CLICKED` already answers "which nav link drove the click".
 *   Pinned by a `not.toContain('nav')` assertion in this file's guard test.
 * - `'hero'` — the hero's only CTA is the search submit, which has its own richer event
 *   (`HERO_SEARCH_SUBMITTED`). No emitter exists.
 * - `'pricing'` — the pricing section has no CTA at all, and this ticket does not invent one.
 *
 * Shipping a declared-never-emitted value is only justified when a DESTINATION is coming (as
 * with `MARKETING_NAV_LINKS`' two `TODO(MJ)` link keys). It is not, here: EVERY member of this
 * union has exactly ONE live emitter.
 */
export const MARKETING_HOME_CTA_PLACEMENTS = ['ways', 'experts', 'band', 'final'] as const;
export type MarketingHomeCtaPlacement = (typeof MARKETING_HOME_CTA_PLACEMENTS)[number];

/** Which of the hero's two parallax bench rows a product tile sits in. */
export const MARKETING_HOME_BENCH_ROWS = ['a', 'b'] as const;
export type MarketingHomeBenchRow = (typeof MARKETING_HOME_BENCH_ROWS)[number];

/** Which hero control put a product into (or out of) the search selection. */
export const MARKETING_HOME_PRODUCT_SOURCES = ['facet', 'chip'] as const;
export type MarketingHomeProductSource = (typeof MARKETING_HOME_PRODUCT_SOURCES)[number];

/** Which of a spotlight card's two CTAs was taken. */
export const MARKETING_HOME_SPOTLIGHT_ACTIONS = ['profile', 'book'] as const;
export type MarketingHomeSpotlightAction = (typeof MARKETING_HOME_SPOTLIGHT_ACTIONS)[number];

export const MARKETING_HOME_EVENTS = {
  /** The hero search form was submitted (the page's primary client funnel entry). */
  HERO_SEARCH_SUBMITTED: 'marketing_home_hero_search_submitted',
  /** The hero's product-selector popover was opened. */
  HERO_FACET_OPENED: 'marketing_home_hero_facet_opened',
  /** A product was added to or removed from the hero selection. */
  HERO_PRODUCT_TOGGLED: 'marketing_home_hero_product_toggled',
  /** One of the 18 bench tiles was activated. */
  PRODUCT_TILE_CLICKED: 'marketing_home_product_tile_clicked',
  /** A spotlight expert card's profile or book CTA was activated. */
  SPOTLIGHT_EXPERT_CLICKED: 'marketing_home_spotlight_expert_clicked',
  /** A page CTA was activated. See the placement union's omission notes. */
  CTA_CLICKED: 'marketing_home_cta_clicked',
  /** A section scrolled into view (one-shot per section, per page view). */
  SECTION_VIEWED: 'marketing_home_section_viewed',
} as const;

export interface MarketingHomeEventMap {
  /**
   * `query_length`, NEVER the query text. Named `query_length` (not the ticket's `query_len`)
   * to match `SearchComposerSnapshot.query_length` (`events/search.ts`), so the home funnel and
   * the `/experts` funnel are directly comparable in PostHog.
   */
  [MARKETING_HOME_EVENTS.HERO_SEARCH_SUBMITTED]: {
    query_length: number;
    product_count: number;
    products: string[];
  };
  [MARKETING_HOME_EVENTS.HERO_FACET_OPENED]: Record<string, never>;
  /** `selected` distinguishes add from remove — a toggle event without it is unanalysable. */
  [MARKETING_HOME_EVENTS.HERO_PRODUCT_TOGGLED]: {
    product: string;
    source: MarketingHomeProductSource;
    selected: boolean;
  };
  /**
   * `count_shown` is the only way to answer whether the tile's count line drives clicks —
   * which is the entire justification for the `<10` hide rule.
   */
  [MARKETING_HOME_EVENTS.PRODUCT_TILE_CLICKED]: {
    product: string;
    row: MarketingHomeBenchRow;
    position: number;
    count_shown: boolean;
  };
  /** `position` captures ordering effects across the 3-card row. */
  [MARKETING_HOME_EVENTS.SPOTLIGHT_EXPERT_CLICKED]: {
    expert_id: string;
    action: MarketingHomeSpotlightAction;
    position: number;
  };
  [MARKETING_HOME_EVENTS.CTA_CLICKED]: {
    placement: MarketingHomeCtaPlacement;
    label: string;
  };
  /** Named `section` (not the ticket's `section_id`) to match `expert_profile_section_viewed`. */
  [MARKETING_HOME_EVENTS.SECTION_VIEWED]: { section: MarketingHomeSection };
}
