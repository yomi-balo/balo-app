// BAL-377 (ADR-1040 Lane 1) credit purchase / top-up CLIENT funnel events, plus
// BAL-380 (Lane 3) dormancy / expiry / display-FX SERVER events. Snake_case values,
// feature-prefixed `credit_` (matches `credit_wallets`, `creditLedgerRepository`, the
// `CREDIT_*` enums); `promo_redeemed` / `mandate_captured` keep the noun they describe.
//
// -- Client events (fire from the browser via `track()`) ---------------------------
// BAL-377: the four top-up funnel events. These are CLIENT-OBSERVED signals — the
// authoritative money source of truth is the shipped BAL-382 Stripe webhook (which
// credits the wallet), NOT these events. PURCHASE_STARTED fires on the Pay press;
// PURCHASE_COMPLETED / PROMO_REDEEMED / MANDATE_CAPTURED fire on the receipt (Step 2)
// once the client-side confirmation succeeds. No `identify`/`reset` (no session change).
export const CREDIT_EVENTS = {
  /** Pay pressed — a top-up attempt started (client-observed funnel entry). */
  PURCHASE_STARTED: 'credit_purchase_started',
  /** Receipt shown — the client-side confirmation succeeded (money via the webhook). */
  PURCHASE_COMPLETED: 'credit_purchase_completed',
  /** Receipt shown with a promo applied — the shown bonus grant (webhook grants it). */
  PROMO_REDEEMED: 'promo_redeemed',
  /** SetupIntent confirmed — a reusable off-session card mandate was captured. */
  MANDATE_CAPTURED: 'mandate_captured',
  /** Top-up redesign — the buyer swapped between their saved card and a new one. */
  PAYMENT_METHOD_CHANGED: 'credit_payment_method_changed',
  /** Top-up redesign — a saved-card charge was refused (a USER outcome, not a system fault). */
  PURCHASE_DECLINED: 'credit_purchase_declined',
} as const;

/** Which card a purchase charges. Mirrors the api/web `PaymentMethodSource` union. */
export type PaymentMethodSourceProperty = 'new_card' | 'saved_card';

export interface CreditEventMap {
  [CREDIT_EVENTS.PURCHASE_STARTED]: {
    amount_minor: number;
    promo_applied: boolean;
    /**
     * Always `'card'` since Invoice left the UI. KEPT rather than removed — dropping it would
     * churn a live PostHog property (and every dashboard built on it) for no gain.
     */
    funding_method: 'card' | 'invoice';
    low_balance_mode: 'auto_topup' | 'keep_going' | 'notify_only';
    /** Top-up redesign — new card entered, or the card already on file. */
    payment_method_source?: PaymentMethodSourceProperty;
  };
  [CREDIT_EVENTS.PURCHASE_COMPLETED]: {
    amount_minor: number;
    promo_applied: boolean;
    funding_method: 'card' | 'invoice';
    low_balance_mode: 'auto_topup' | 'keep_going' | 'notify_only';
    payment_method_source?: PaymentMethodSourceProperty;
  };
  [CREDIT_EVENTS.PROMO_REDEEMED]: { code: string; bonus_minor: number };
  [CREDIT_EVENTS.MANDATE_CAPTURED]: { low_balance_mode: 'auto_topup' | 'keep_going' };
  [CREDIT_EVENTS.PAYMENT_METHOD_CHANGED]: { to: PaymentMethodSourceProperty };
  [CREDIT_EVENTS.PURCHASE_DECLINED]: {
    amount_minor: number;
    /** Stripe's specific refusal reason when it gave one; `null` otherwise. */
    decline_code: string | null;
  };
}

// -- Server events (fire from workers/sweeps via `trackServer`) --------------------
// `_dormancy_reminder_sent` fires per (wallet, band) when the sweep publishes a reminder;
// `_balance_expired` fires ONLY when the sweep posts the expiry entry (outcome 'expired',
// never on an idempotent replay — no double-count of the money event); `_fx_cache_stale`
// is a daily, low-volume operational signal that a served display-FX quote is >48h old.
export const CREDIT_SERVER_EVENTS = {
  /** The dormancy sweep published a 60d / 30d reminder for a wallet. */
  DORMANCY_REMINDER_SENT: 'credit_dormancy_reminder_sent',
  /** The expiry sweep posted the zeroing expiry entry (real money event; never on replay). */
  BALANCE_EXPIRED: 'credit_balance_expired',
  /** The FX sweep served a display-FX cache row older than the 48h staleness threshold. */
  FX_CACHE_STALE: 'credit_fx_cache_stale',
  /**
   * BAL-379: a between-session auto-top-up reload was CREDITED (money-in truth). Fires from
   * the `payment_intent.succeeded` webhook's executed branch, exactly once per crossing via
   * the ledger idempotency key (never on a deduped replay).
   */
  AUTO_TOPUP_FIRED: 'credit_auto_topup_fired',
  /**
   * BAL-379: a between-session auto-top-up charge could NOT complete (money-not-in). Fires
   * from the SYNC engine only (`requires_action` / hard decline); the async
   * `payment_intent.payment_failed` recovery belt is notification-only (no analytics).
   */
  AUTO_TOPUP_FAILED: 'credit_auto_topup_failed',
} as const;

/** Display-FX quote currency (string-compatible with `@balo/db` FxDisplayQuote). */
export type FxDisplayQuoteCode = 'GBP' | 'EUR' | 'USD';

export interface CreditServerEventMap {
  [CREDIT_SERVER_EVENTS.DORMANCY_REMINDER_SENT]: {
    window: 60 | 30;
    company_id: string;
    wallet_id: string;
    /** = company_id (the natural subject of a wallet-level notice). */
    distinct_id: string;
  };
  [CREDIT_SERVER_EVENTS.BALANCE_EXPIRED]: {
    expired_minor: number;
    company_id: string;
    wallet_id: string;
    /** = company_id. */
    distinct_id: string;
  };
  [CREDIT_SERVER_EVENTS.FX_CACHE_STALE]: {
    quote: FxDisplayQuoteCode;
    as_of_age_hours: number;
    /** = 'system:fx-display' (no acting user — matches the onboarding-sweep system:* precedent). */
    distinct_id: string;
  };
  [CREDIT_SERVER_EVENTS.AUTO_TOPUP_FIRED]: {
    /** AUD reload FACE value credited (no fee/margin — fee-concealment posture). */
    amount_minor: number;
    /** Resting balance that triggered the reload (pre-reload). */
    trigger_balance_minor: number;
    company_id: string;
    wallet_id: string;
    /** = company_id (the natural subject of a wallet-level money event). */
    distinct_id: string;
  };
  [CREDIT_SERVER_EVENTS.AUTO_TOPUP_FAILED]: {
    /** AUD reload FACE value we attempted to charge. */
    amount_minor: number;
    /** Resting balance at fire time. */
    trigger_balance_minor: number;
    failure_reason: 'declined' | 'requires_action';
    /** Stripe decline code when present. */
    failure_code?: string;
    company_id: string;
    wallet_id: string;
    /** = company_id. */
    distinct_id: string;
  };
}
