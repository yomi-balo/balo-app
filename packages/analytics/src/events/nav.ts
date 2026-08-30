import type { Workspace } from '@balo/shared/workspaces';

/**
 * BAL-495 / ADR-1053 — ⚠ THE CANONICAL NAV KEY TUPLE. `apps/web`'s `nav-registry.ts` types its
 * `key` field as `NavItemKey`, so a nav entry and an analytics `item` value CANNOT drift apart.
 * Same discipline as `CONVERSATION_CALL_SURFACES`. Includes the three DISABLED placeholder keys
 * (BAL-497/500) — declared vocabulary, not yet emittable.
 */
export const NAV_ITEM_KEYS = [
  'dashboard',
  'find_experts',
  'consultations',
  'projects',
  'calendar',
  'messages',
  'expert_settings',
  'settings', // BAL-503 — the client counterpart to `expert_settings`.
  'team',
  'account',
  'help',
] as const;
export type NavItemKey = (typeof NAV_ITEM_KEYS)[number];

/**
 * The ADR-1053 surfaces. ⚠ BAL-501 DELETED THE MOBILE DRAWER, so `'sidebar'` now means DESKTOP
 * for the first time — the old note here ("the mobile DRAWER reports 'sidebar'") no longer holds
 * and must not be left in place to mislead a PostHog query.
 * `'command_palette'` (BAL-503) is still declared-but-unemitted.
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
} as const;

export interface NavEventMap {
  [NAV_EVENTS.ITEM_CLICKED]: {
    item: NavItemKey;
    surface: NavSurface;
    /** `Workspace['type']` imported, never re-declared — `@balo/shared/workspaces` is its home. */
    workspace_type: Workspace['type'];
  };
  [NAV_EVENTS.MORE_OPENED]: { workspace_type: Workspace['type'] };
}
