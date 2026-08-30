/**
 * BAL-500 / ADR-1053 — the ⌘K command palette's CLIENT event family.
 *
 * ⚠ CANNOT join `NAV_EVENTS`: `events/nav.test.ts:6` pins `Object.keys(NAV_EVENTS)` to exactly
 * `['ITEM_CLICKED']`, and `:13-17` pins every value to `/^nav_[a-z]+(_[a-z]+)*$/`.
 *
 * ⚠⚠ NAVIGATION IS DELIBERATELY ABSENT FROM THIS FAMILY. The ticket specified
 * `command_palette_action { type: 'navigate' | 'switch_workspace' }`. `'navigate'` is OMITTED
 * because BAL-495 already ships `nav_item_clicked { item, surface, workspace_type }` and RESERVED
 * `surface: 'command_palette'` for exactly this palette (`events/nav.ts:23-29`, pinned
 * `nav.test.ts:44`). Shipping both would double-count every palette navigation; shipping the union
 * member without emitting it would ship a dead vocabulary. To measure the navigate half, join
 * `nav_item_clicked` on `surface = 'command_palette'`.
 */

/** How the palette was opened. The ticket's business question: which entry method wins? */
export const COMMAND_PALETTE_OPEN_METHODS = ['shortcut', 'click'] as const;
export type CommandPaletteOpenMethod = (typeof COMMAND_PALETTE_OPEN_METHODS)[number];

/** SINGLE-MEMBER ON PURPOSE — see the ⚠⚠ note above before widening this. */
export const COMMAND_PALETTE_ACTION_TYPES = ['switch_workspace'] as const;
export type CommandPaletteActionType = (typeof COMMAND_PALETTE_ACTION_TYPES)[number];

export const COMMAND_PALETTE_EVENTS = {
  /** The palette was opened. Emitted ONCE per open; a toggle-CLOSE emits nothing. */
  OPENED: 'command_palette_opened',
  /** A non-navigation action was taken. INTENT grain — the server's `workspace_switched` is the
   *  outcome; join the two for the success rate. */
  ACTION: 'command_palette_action',
} as const;

export interface CommandPaletteEventMap {
  [COMMAND_PALETTE_EVENTS.OPENED]: { method: CommandPaletteOpenMethod };
  [COMMAND_PALETTE_EVENTS.ACTION]: {
    type: CommandPaletteActionType;
    /** The target `Workspace['key']` — `'expert'` or `company:<uuid>`. */
    destination: string;
  };
}
