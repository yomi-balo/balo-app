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
} as const;

export interface SettingsEventMap {
  [SETTINGS_EVENTS.SECTION_VIEWED]: { section: SettingsSection };
  [SETTINGS_EVENTS.BILLING_TOPUP_CLICKED]: { balance_minor: number };
  [SETTINGS_EVENTS.BILLING_REDEEM_CLICKED]: { balance_minor: number };
}
