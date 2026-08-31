import { isNavItemActive } from './is-nav-item-active';

/**
 * BAL-497 (D5) — the sliding active pill's geometry, derived by PURE INDEX ARITHMETIC rather than
 * DOM measurement. `offsetTop`/`offsetHeight` are always `0` in jsdom and `ResizeObserver` does
 * not exist there, so a measured pill (the design reference's approach,
 * `.claude/design-references/balo-nav-explorer.jsx:806-826`) is unassertable in vitest — and
 * per-item refs would have to be COMPOSED through Radix `TooltipTrigger asChild`, which already
 * claims the collapsed link's child ref. Sidebar rows are uniform by construction (`h-11` on
 * every `SidebarNavLink`), so arithmetic is not an approximation of the measured value — it is
 * exact.
 */

/** The sidebar row's FIXED height in px — `h-11` on every `SidebarNavLink`. Changing one without
 *  the other desynchronises the pill; `sidebar-nav-pill.test.ts`'s PITCH PIN fails if you do. */
export const SIDEBAR_NAV_ROW_HEIGHT_PX = 44;

/** The gap between rows in px — `gap-1` on `SidebarNavSection`'s row stack. */
export const SIDEBAR_NAV_ROW_GAP_PX = 4;

/** Vertical distance between two consecutive rows' TOP edges. The pill's whole geometry. */
export const SIDEBAR_NAV_ROW_PITCH_PX = SIDEBAR_NAV_ROW_HEIGHT_PX + SIDEBAR_NAV_ROW_GAP_PX;

export interface SidebarNavPillState {
  /** Row index within the section, or -1 when the active route is outside this section. */
  readonly activeIndex: number;
  /** `translateY` in px. 0 when nothing is active — the pill parks at row 0 while faded out. */
  readonly offsetPx: number;
  /** Whether the pill paints. It is NEVER unmounted (D5) — that would kill the transition. */
  readonly isVisible: boolean;
}

/**
 * Resolves the sliding pill's position within ONE section (primary or secondary).
 *
 * Why longest-match, not `findIndex`: `isNavItemActive` is a prefix-with-separator rule, so a
 * pathname like `/settings/account` can match BOTH `/settings` and `/settings/account` at once.
 * Each link answers that question independently (BAL-495's frozen per-link rule — both rows may
 * legitimately tint, out of scope here), but there is only ONE pill, so it must choose. A
 * `findIndex` would park it on the shallower, less specific parent; picking the longest matching
 * href is order-independent and always resolves to the most specific row.
 *
 * Why `offsetPx` is 0 rather than "the last active row" when nothing matches: see
 * `sidebar-nav-pill.test.ts` and plan §9.1 — holding the last position would require component
 * state written during render, which would make this helper impure.
 *
 * Why `isNavItemActive` is reused, never re-derived: BAL-495/501 made it the single active rule
 * for this codebase. A second definition here is exactly the drift `is-nav-item-active.ts` was
 * extracted to prevent.
 */
export function resolveSidebarNavPill(
  hrefs: readonly string[],
  pathname: string
): SidebarNavPillState {
  let activeIndex = -1;
  let bestHrefLength = -1;
  hrefs.forEach((href, index) => {
    if (isNavItemActive(pathname, href) && href.length > bestHrefLength) {
      activeIndex = index;
      bestHrefLength = href.length;
    }
  });
  return {
    activeIndex,
    offsetPx: Math.max(activeIndex, 0) * SIDEBAR_NAV_ROW_PITCH_PX,
    isVisible: activeIndex >= 0,
  };
}
