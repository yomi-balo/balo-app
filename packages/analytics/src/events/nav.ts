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
 * The three ADR-1053 surfaces. Only `'sidebar'` is emitted today; `'bottom_tabs'` (BAL-501) and
 * `'command_palette'` (BAL-503) are declared-but-unemitted, exactly like the disabled registry
 * entries. ⚠ The mobile DRAWER reports `'sidebar'` — it renders `SidebarContent` verbatim.
 */
export const NAV_SURFACES = ['sidebar', 'bottom_tabs', 'command_palette'] as const;
export type NavSurface = (typeof NAV_SURFACES)[number];

export const NAV_EVENTS = {
  /** A nav destination was activated. CLIENT-side; `useNavItemTracking` is the ONE dispatch point. */
  ITEM_CLICKED: 'nav_item_clicked',
} as const;

export interface NavEventMap {
  [NAV_EVENTS.ITEM_CLICKED]: {
    item: NavItemKey;
    surface: NavSurface;
    /** `Workspace['type']` imported, never re-declared — `@balo/shared/workspaces` is its home. */
    workspace_type: Workspace['type'];
  };
}
