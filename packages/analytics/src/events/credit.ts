// BAL-380 (ADR-1040 Lane 3) credit dormancy / expiry / display-FX server events.
// Snake_case values, feature-prefixed `credit_` (matches `credit_wallets`,
// `creditLedgerRepository`, the `CREDIT_*` enums). ALL server-emitted (`trackServer`) —
// there are no client events, so this feature adds NOTHING to `AllEvents`.
//
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
}
