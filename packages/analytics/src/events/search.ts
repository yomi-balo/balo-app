/**
 * Client-side (browser) search events. These complement the server-emitted
 * `search_performed` / `search_zero_results` with UI context (position, layout,
 * pagination) that only the page can observe. Do NOT duplicate the server events.
 */
export const SEARCH_EVENTS = {
  RESULT_CLICKED: 'search_result_clicked',
  ZERO_RESULTS_VIEWED: 'search_zero_results_viewed',
  LAYOUT_TOGGLED: 'search_layout_toggled',
  FILTERS_OPENED: 'search_filters_opened',
  PAGINATION: 'search_pagination',
  // Search Composer (BAL-249) — explicit submits, live refinements, and the
  // product-selector interaction funnel.
  SUBMITTED: 'search_submitted',
  REFINED: 'search_refined',
  PRODUCT_SELECTOR_OPENED: 'search_product_selector_opened',
  PRODUCT_SELECTOR_SEARCHED: 'search_product_selector_searched',
  PRODUCT_GROUP_EXPANDED: 'search_product_group_expanded',
  COMPOSER_CLEARED: 'search_composer_cleared',
  FACET_CLEARED: 'search_facet_cleared',
} as const;

/** The facet sections that carry their own Clear control (`search_facet_cleared`). */
export const SEARCH_CLEARABLE_FACETS = ['support_types', 'timeframe', 'rate', 'languages'] as const;

export type SearchClearableFacet = (typeof SEARCH_CLEARABLE_FACETS)[number];

/**
 * Shared property snapshot carried by both `search_submitted` and `search_refined`.
 * Mirrors `apps/web/src/lib/search/composer-analytics.ts` `SearchSnapshot` — keep
 * the two in sync (cross-app import is forbidden, so this is duplicated by design).
 */
export interface SearchComposerSnapshot {
  has_query: boolean;
  query_length: number;
  products: string[];
  product_count: number;
  support_types: string[];
  support_count: number;
  timeframe: 'any' | 'today' | '3days' | 'week';
  has_rate_filter: boolean;
  rate_min: number | null;
  rate_max: number | null;
  languages: string[];
  language_count: number;
}

/**
 * Which part of a result card opened the profile: the whole-card/name link, the View profile
 * button, or the "+N more products" link. The tuple is the source; the union is DERIVED from it
 * so a test can pin the exact set.
 */
export const SEARCH_RESULT_PROFILE_TARGETS = ['card', 'button', 'more_products'] as const;

export type SearchResultProfileTarget = (typeof SEARCH_RESULT_PROFILE_TARGETS)[number];

export interface SearchEventMap {
  [SEARCH_EVENTS.RESULT_CLICKED]: {
    expert_id: string;
    position: number;
    sort: string;
    page: number;
  } & (
    | {
        /**
         * Which of the card's two CTAs was taken. `book` fires before the booking flow loads, so
         * a signed-out visitor who stops at the auth modal is still counted.
         *
         * ⚠ Added 2026-10-23 (PR #411); Book clicks were untracked before then. Earlier events
         * carry no `action` and are all profile clicks, so a profile-click insight must keep
         * `action` unset OR `'profile'`, and the event's raw volume steps up from that date.
         */
        action: 'profile';
        /**
         * Which part of the card opened the profile (see `SEARCH_RESULT_PROFILE_TARGETS`).
         *
         * ⚠ `target` was added in BAL-640 (2026-11). Profile events before that date carry no
         * `target`.
         */
        target?: SearchResultProfileTarget;
      }
    | { action: 'book'; target?: never }
  );
  [SEARCH_EVENTS.ZERO_RESULTS_VIEWED]: {
    filters: Record<string, unknown>;
    was_availability_gated: boolean;
  };
  [SEARCH_EVENTS.LAYOUT_TOGGLED]: { to: 'grid' | 'list' };
  [SEARCH_EVENTS.FILTERS_OPENED]: Record<string, never>;
  [SEARCH_EVENTS.PAGINATION]: { to_page: number };
  [SEARCH_EVENTS.SUBMITTED]: SearchComposerSnapshot & {
    surface: 'hero_bar' | 'compact_bar' | 'mobile_sheet';
    path: 'query_only' | 'facets_only' | 'both' | 'none';
  };
  [SEARCH_EVENTS.REFINED]: SearchComposerSnapshot & {
    surface: 'rail' | 'compact_bar';
  };
  [SEARCH_EVENTS.PRODUCT_SELECTOR_OPENED]: { surface: 'popover' | 'rail' | 'sheet' };
  [SEARCH_EVENTS.PRODUCT_SELECTOR_SEARCHED]: { had_results: boolean };
  [SEARCH_EVENTS.PRODUCT_GROUP_EXPANDED]: { group: string };
  [SEARCH_EVENTS.COMPOSER_CLEARED]: { surface: 'hero_bar' | 'compact_bar' | 'rail' | 'sheet' };
  [SEARCH_EVENTS.FACET_CLEARED]: {
    facet: SearchClearableFacet;
    surface: 'rail' | 'sheet';
  };
}

export const SEARCH_SERVER_EVENTS = {
  SEARCH_PERFORMED: 'search_performed',
  SEARCH_ZERO_RESULTS: 'search_zero_results',
} as const;

export interface SearchServerEventMap {
  [SEARCH_SERVER_EVENTS.SEARCH_PERFORMED]: {
    has_query: boolean;
    filter_count: number;
    result_count: number;
    sort: string;
    vertical: string;
    distinct_id: string;
  };
  [SEARCH_SERVER_EVENTS.SEARCH_ZERO_RESULTS]: {
    query: string;
    filters: Record<string, unknown>;
    distinct_id: string;
  };
}
