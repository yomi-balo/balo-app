/**
 * BAL-502 / ADR-1053 — the public marketing chrome's CLIENT event family.
 * ⚠ Deliberately SEPARATE from `NAV_EVENTS`: `NAV_ITEM_KEYS` is a pinned 10-key DASHBOARD
 * tuple (`nav.ts:9-20`, pinned by `nav.test.ts:36-39`) resolved through `buildNavContext`,
 * which is `server-only` and hits `companiesRepository.findById`. The marketing links are
 * public, ungated and reachable by anonymous visitors. Routing them through the nav registry
 * would break that pinned tuple and drag a DB-backed server-only context onto a public page.
 */

/**
 * ⚠ THE CANONICAL MARKETING LINK TUPLE. `marketing-nav.ts` types its `key` field from this,
 * so a rendered link and an analytics `link` value cannot drift apart (same discipline as
 * `NAV_ITEM_KEYS`). Includes the two links the design reference specifies but that have no
 * destination yet — declared vocabulary, not yet emittable, exactly like BAL-495's disabled keys.
 */
export const MARKETING_NAV_LINKS = [
  'find_experts',
  'for_experts',
  'how_it_works', // TODO(MJ): no page yet — declared, never emitted
  'pricing', // TODO(MJ): no page yet — declared, never emitted
] as const;
export type MarketingNavLink = (typeof MARKETING_NAV_LINKS)[number];

/** Where in the marketing chrome the click happened. */
export const MARKETING_SURFACES = ['header', 'mobile_menu'] as const;
export type MarketingSurface = (typeof MARKETING_SURFACES)[number];

export const MARKETING_EVENTS = {
  /** A marketing nav link was activated (desktop bar or mobile sheet). */
  NAV_CLICKED: 'marketing_nav_clicked',
  /** A signed-in visitor returned to the app shell. Leg 2 of the ADR-1053 ping-pong metric. */
  DASHBOARD_CLICKED: 'marketing_dashboard_clicked',
  /**
   * ⚠ BAL-493 / D3 — UNEMITTED as of BAL-493. The signed-out header CTA was replaced by
   * "Find an expert" (a plain `<Link href="/experts">`, no tracking dispatch); this key and
   * its value are KEPT, not deleted, because PostHog holds historical data under it. Same
   * declared-but-unemitted treatment as `MARKETING_NAV_LINKS`' `how_it_works`/`pricing` and
   * BAL-495's disabled keys. If a future "Get started"-shaped CTA returns to the marketing
   * chrome, re-wire it to THIS constant rather than minting a new one.
   */
  GET_STARTED_CLICKED: 'marketing_get_started_clicked',
} as const;

export interface MarketingEventMap {
  [MARKETING_EVENTS.NAV_CLICKED]: { link: MarketingNavLink; surface: MarketingSurface };
  [MARKETING_EVENTS.DASHBOARD_CLICKED]: { surface: MarketingSurface };
  [MARKETING_EVENTS.GET_STARTED_CLICKED]: { surface: MarketingSurface };
}
