/**
 * Server-side promo events (emitted via trackServer from a Server Action, never the
 * browser). `promo_code_created` fires on a successful mint. It is a SERVER event
 * because a promo mint is an admin action whose grant/cap figures are admin-audience
 * data that must never transit a client bundle — the same audience-boundary invariant
 * as `ADMIN_PROJECT_FEE_OVERRIDDEN` (BAL-358). No PII: only the code id, the config
 * figures, the validity window, and the acting admin's `distinct_id` (user UUID).
 *
 * Deactivate / cap-edit deliberately emit NO analytics (BAL-384 scopes analytics to
 * the mint only); redemption-time events belong to BAL-383.
 */
export const PROMO_SERVER_EVENTS = {
  PROMO_CODE_CREATED: 'promo_code_created',
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
}
