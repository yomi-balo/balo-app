/**
 * BAL-503 / ADR-1053 — the client Settings surface's CLIENT event family.
 * ⚠ Deliberately SEPARATE from `NAV_EVENTS`: `nav.test.ts:5-7` asserts `Object.keys(NAV_EVENTS)`
 * equals exactly `['ITEM_CLICKED']`, so extending that constant is invasive by design (M6).
 * `NAV_EVENTS` is about ACTIVATING a nav destination; this is about ARRIVING at a section.
 */

/**
 * ⚠ THE CANONICAL SETTINGS SECTION TUPLE — and simultaneously the ROUTE SEGMENTS under
 * `/settings/<section>`. `_lib/settings-sections.ts` types its `key` field from this, so a rendered
 * tab, a URL segment, and an analytics `section` value CANNOT drift apart. Same discipline as
 * `NAV_ITEM_KEYS` / `MARKETING_NAV_LINKS`.
 */
export const SETTINGS_SECTIONS = ['company', 'team', 'billing', 'notifications'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SETTINGS_EVENTS = {
  /** A Settings section was viewed. CLIENT-side; `SettingsSectionNav` is the ONE dispatch point. */
  SECTION_VIEWED: 'settings_section_viewed',
  /**
   * Top-up intent originating in Settings. ⚠ A SEPARATE series from `WALLET_EVENTS.TOPUP_CLICKED`,
   * which stays the DASHBOARD card's signal — following the BAL-499 precedent, where the wallet's
   * second surface (the top-bar chip) minted `CHIP_CLICKED` rather than sharing or silently
   * skipping the existing event. Sharing it would have made an already-shipped series ambiguous;
   * skipping it would have made Settings-originated intent invisible.
   */
  BILLING_TOPUP_CLICKED: 'settings_billing_topup_clicked',
  /**
   * Redemption intent. Settings is `/redeem`'s FIRST entry point in the product (pre-flight O5:
   * nothing linked to it before), so without this the ticket's own headline win is unmeasurable.
   */
  BILLING_REDEEM_CLICKED: 'settings_billing_redeem_clicked',
  /**
   * BAL-516 — the low-balance mode/band Save on `/settings/billing` succeeded. `mode` is the
   * mode JUST SAVED (the outgoing selection), not necessarily card-backed.
   */
  BILLING_LOW_BALANCE_SAVED: 'settings_billing_low_balance_saved',
  /**
   * BAL-516 — a Save-time mandate arm against the ALREADY-STORED card resolved `captured`
   * (including after a 3DS `handleNextAction` round-trip). `mode` is always card-backed —
   * this only ever fires for `auto_topup` / `keep_going`.
   */
  BILLING_MANDATE_ARMED: 'settings_billing_mandate_armed',
  /**
   * BAL-516 — a card was saved via the settings capture panel, either an inline `confirmSetup`
   * success or a 3DS redirect-return resolving `succeeded`. `intent` distinguishes the
   * empty-state "Add" flow from a "Change" over an existing card.
   */
  BILLING_CARD_SAVED: 'settings_billing_card_saved',
  /**
   * BAL-516 — `removeSavedCardAction` returned ok. `mode_reconciled` is `true` iff the wallet
   * was on a card-backed mode that the removal transaction moved to `notify_only`.
   */
  BILLING_CARD_REMOVED: 'settings_billing_card_removed',
} as const;

export interface SettingsEventMap {
  [SETTINGS_EVENTS.SECTION_VIEWED]: { section: SettingsSection };
  [SETTINGS_EVENTS.BILLING_TOPUP_CLICKED]: { balance_minor: number };
  [SETTINGS_EVENTS.BILLING_REDEEM_CLICKED]: { balance_minor: number };
  [SETTINGS_EVENTS.BILLING_LOW_BALANCE_SAVED]: {
    mode: 'auto_topup' | 'keep_going' | 'notify_only';
  };
  [SETTINGS_EVENTS.BILLING_MANDATE_ARMED]: { mode: 'auto_topup' | 'keep_going' };
  [SETTINGS_EVENTS.BILLING_CARD_SAVED]: { intent: 'add' | 'change' };
  [SETTINGS_EVENTS.BILLING_CARD_REMOVED]: { mode_reconciled: boolean };
}
