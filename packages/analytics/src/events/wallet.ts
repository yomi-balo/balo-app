// BAL-402 (ADR-1040 surface) dashboard wallet-widget CLIENT events. Snake_case values,
// feature-prefixed `wallet_` (matches the `WalletWidget` primitive + the client-lens wallet
// surface). These are CLIENT-OBSERVED intent/exposure signals only — the authoritative money
// source of truth stays the shipped BAL-382 Stripe webhook, never these events.
//
// WIDGET_VIEWED fires once on card mount for a resolved resting state (holder or member lens);
// loading / error emit nothing (no meaningful lens/state). NUDGE_CLICKED fires when a member
// presses the nudge (on intent, before the async result). TOPUP_CLICKED fires when a holder
// clicks Top up, before navigating to `/billing/top-up`. No `identify` / `reset` — the
// dashboard triggers no session change.
export const WALLET_EVENTS = {
  /** Wallet card mounted with a resolved resting state (holder or member lens). */
  WIDGET_VIEWED: 'wallet_widget_viewed',
  /** Member pressed the nudge to ask a billing holder to top up (fires on intent). */
  NUDGE_CLICKED: 'wallet_nudge_clicked',
  /** Holder clicked Top up (fires before navigation to the top-up route). */
  TOPUP_CLICKED: 'wallet_topup_clicked',
} as const;

/** The lens the wallet card resolved to (capability-branched, never role/activeMode). */
export type WalletLens = 'holder' | 'member';

/** The resting state the balance resolved to (pure display over the AUD-minor balance). */
export type WalletRestingStateName = 'healthy' | 'low' | 'zero';

export interface WalletEventMap {
  [WALLET_EVENTS.WIDGET_VIEWED]: { lens: WalletLens; state: WalletRestingStateName };
  [WALLET_EVENTS.NUDGE_CLICKED]: { state: 'low' | 'zero' };
  [WALLET_EVENTS.TOPUP_CLICKED]: { state: WalletRestingStateName };
}
