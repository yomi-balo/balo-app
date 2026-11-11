import type { Workspace } from '@balo/shared/workspaces';
import type { DashboardUpNextMeetingType } from './dashboard';

/**
 * BAL-495 / ADR-1053 — ⚠ THE CANONICAL NAV KEY TUPLE. `apps/web`'s `nav-registry.ts` types its
 * `key` field as `NavItemKey`, so a nav entry and an analytics `item` value CANNOT drift apart.
 * Same discipline as `CONVERSATION_CALL_SURFACES`. Includes the three DISABLED placeholder keys
 * (BAL-497/500) — declared vocabulary, not yet emittable.
 */
export const NAV_ITEM_KEYS = [
  'dashboard',
  'find_experts',
  // ⚠ BAL-567 RENAMED THIS KEY FROM `consultations`, IN PLACE (position 3, authored order
  // preserved). The surface is now "Cases" at `/cases`, and a key still reading `consultations`
  // would be the last place on the platform calling it by the old noun.
  // ⚠⚠ IT BREAKS POSTHOG CONTINUITY FOR nav-click, DELIBERATELY AND WITH THE TICKET'S MANDATE:
  // `nav_item_clicked` rows before and after this commit carry different `item` values and do
  // not aggregate. An alias would have kept one graph whole at the cost of two names for one nav
  // item forever, which is precisely the drift `NAV_ITEM_KEYS` exists to prevent.
  'cases',
  'projects',
  'calendar',
  'messages',
  'expert_settings',
  'settings', // BAL-503 — the client counterpart to `expert_settings`.
  'team',
  'account',
  'help',
  // BAL-534 — the staff-only "Balo admin" group (ADR-1053 Amendment 1). Declared here, like
  // every other nav key, so a registry entry and an analytics `item` value cannot drift.
  // BAL-548 — 'admin_home' leads the group (the queue is the lane's entry point).
  'admin_home',
  // BAL-549 — the expert-application review queue, authored right after 'admin_home' (the
  // registry's own authored order).
  'admin_applications',
  'admin_engagements',
  'admin_promo_codes',
  'admin_catalogue',
  'admin_lookup',
  // BAL-550 — the capture-health detail lens, after `admin_catalogue` per the design's
  // `ADMIN_NAV` order.
  'admin_health',
  // BAL-561 — the Staff access page, authored last in the "Balo admin" block after
  // `admin_lookup` (the registry's own authored order).
  'admin_staff_access',
] as const;
export type NavItemKey = (typeof NAV_ITEM_KEYS)[number];

/**
 * The ADR-1053 surfaces. ⚠ BAL-501 DELETED THE MOBILE DRAWER, so `'sidebar'` now means DESKTOP
 * for the first time — the old note here ("the mobile DRAWER reports 'sidebar'") no longer holds
 * and must not be left in place to mislead a PostHog query.
 * `'command_palette'` is NOW EMITTED — BAL-500 shipped the ⌘K palette, whose nav rows dispatch
 * through the same `useNavItemTracking('command_palette', …)` hook as every other surface. It is
 * deliberately the ONLY measure of palette NAVIGATION: `command_palette_action` narrows its `type`
 * to `'switch_workspace'` precisely so the two families cannot double-count a navigate.
 * All four surfaces are live; none is declared-but-unemitted.
 */
export const NAV_SURFACES = ['sidebar', 'bottom_tabs', 'more_sheet', 'command_palette'] as const;
export type NavSurface = (typeof NAV_SURFACES)[number];

export const NAV_EVENTS = {
  /** A nav destination was activated. CLIENT-side; `useNavItemTracking` is the ONE dispatch point. */
  ITEM_CLICKED: 'nav_item_clicked',
  /** The More sheet was OPENED. An intent signal, not a destination activation — hence a second
   *  member of this family rather than a `surface` on ITEM_CLICKED. Precedent:
   *  `WORKSPACE_EVENTS.SWITCHER_OPENED`. Emitted on open only. */
  MORE_OPENED: 'nav_more_opened',
  /** BAL-636 — a meeting first became the top-nav call pill's primary in this TopNav mount. */
  CALL_PILL_SHOWN: 'nav_call_pill_shown',
  /** BAL-636 — Join was activated in the pill or in its "+N" list. */
  CALL_JOIN_CLICKED: 'nav_call_join_clicked',
  /** BAL-636 — the pill's "+N" list was opened. Emitted on open only. */
  CALL_LIST_OPENED: 'nav_call_list_opened',
} as const;

/** BAL-636 — where a call Join was clicked: the pill itself or a row of its "+N" list. */
export const NAV_CALL_SOURCES = ['pill', 'list'] as const;
export type NavCallSource = (typeof NAV_CALL_SOURCES)[number];

/**
 * BAL-636 — the properties every call-pill event carries. `minutes_to_start` is signed and never
 * floored (negative once the call has started); `quiet` is true when the pill's Join is not the
 * one that animates; `other_workspace` is true for an expert-side call seen from a company
 * workspace.
 */
export interface NavCallEventBase {
  meeting_type: DashboardUpNextMeetingType;
  minutes_to_start: number;
  quiet: boolean;
  other_workspace: boolean;
  workspace_type: Workspace['type'];
}

export interface NavEventMap {
  [NAV_EVENTS.ITEM_CLICKED]: {
    item: NavItemKey;
    surface: NavSurface;
    /** `Workspace['type']` imported, never re-declared — `@balo/shared/workspaces` is its home. */
    workspace_type: Workspace['type'];
  };
  [NAV_EVENTS.MORE_OPENED]: { workspace_type: Workspace['type'] };
  [NAV_EVENTS.CALL_PILL_SHOWN]: NavCallEventBase;
  [NAV_EVENTS.CALL_JOIN_CLICKED]: NavCallEventBase & { source: NavCallSource };
  [NAV_EVENTS.CALL_LIST_OPENED]: NavCallEventBase & { count: number };
}
