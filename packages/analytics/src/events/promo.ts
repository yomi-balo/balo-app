/**
 * Server-side promo events (emitted via trackServer from a Server Action, never the
 * browser). `promo_code_created` fires on a successful mint. It is a SERVER event
 * because a promo mint is an admin action whose grant/cap figures are admin-audience
 * data that must never transit a client bundle — the same audience-boundary invariant
 * as `ADMIN_PROJECT_FEE_OVERRIDDEN` (BAL-358). No PII: only the code id, the config
 * figures, the validity window, and the acting admin's `distinct_id` (user UUID).
 *
 * Deactivate / cap-edit deliberately emit NO analytics (BAL-384 scopes analytics to
 * the mint only); redemption-time events belong to BAL-383 (below).
 */
export const PROMO_SERVER_EVENTS = {
  PROMO_CODE_CREATED: 'promo_code_created',
  // BAL-383: a successful redeem. SERVER events because grant/cap figures are
  // billing-audience data that must never transit a client bundle (same invariant as
  // PROMO_CODE_CREATED). Emitted via trackServer from the redeem Server Action, ONLY on
  // `outcome === 'redeemed'` (never on `already_redeemed`, to avoid double-count).
  PROMO_REDEEMED: 'promo_redeemed',
  PROMO_CODE_REDEEMED_VS_CAP: 'promo_code_redeemed_vs_cap',
} as const;

export interface PromoServerEventMap {
  // BAL-384: emitted server-side from the admin mint action, ONLY on a successful
  // persist. `distinct_id` is the acting admin. `valid_from` / `valid_until` are ISO
  // strings (never a `Date`, which posthog-node can't serialise faithfully).
  [PROMO_SERVER_EVENTS.PROMO_CODE_CREATED]: {
    promo_code_id: string;
    grant_minor: number;
    per_code_redemption_cap: number;
    valid_from: string;
    valid_until: string;
    distinct_id: string;
  };
  // BAL-383: a client redeemed a promo code. `distinct_id` is the redeeming user;
  // `granted_minor` is the AUD minor-unit grant.
  [PROMO_SERVER_EVENTS.PROMO_REDEEMED]: {
    promo_code_id: string;
    granted_minor: number;
    distinct_id: string;
  };
  // BAL-383: redemption-vs-cap utilisation, emitted alongside PROMO_REDEEMED so the
  // code's fill can be tracked over time. `utilisation_pct` is 0–100 (redeemed / cap).
  [PROMO_SERVER_EVENTS.PROMO_CODE_REDEEMED_VS_CAP]: {
    promo_code_id: string;
    redeemed_count: number;
    per_code_redemption_cap: number;
    utilisation_pct: number;
    distinct_id: string;
  };
}

/**
 * Client-side promo events (BAL-383, emitted via `track` from the browser). These carry
 * NO grant/cap figures — only the `company_id` context — so they are safe on the client
 * bundle (unlike the server events above).
 */
export const PROMO_EVENTS = {
  // Fired when the continue-to-mandate prompt RENDERS on the redeem-success screen — the
  // offer to add a card is shown; it does NOT mean the balance is spent (at grant time the
  // balance is full). Named for what it measures: the `prompt_shown → card_captured`
  // funnel. The true consume-time "balance exhausted" signal is BAL-378's to add, and this
  // name deliberately leaves `promo_balance_exhausted` free for it — no two sources for one
  // event name.
  PROMO_CONTINUE_PROMPT_SHOWN: 'promo_continue_prompt_shown',
  // Fired when the Stripe Elements `confirmSetup` succeeds on the continue path.
  PROMO_CONTINUE_CARD_CAPTURED: 'promo_continue_card_captured',
} as const;

export interface PromoEventMap {
  [PROMO_EVENTS.PROMO_CONTINUE_PROMPT_SHOWN]: {
    company_id: string;
  };
  [PROMO_EVENTS.PROMO_CONTINUE_CARD_CAPTURED]: {
    company_id: string;
  };
}
