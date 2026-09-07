/**
 * BAL-529 §D — the Stripe redirect-return family. CROSS-SURFACE by construction: the one
 * dispatch point is `useSetupIntentRedirectReturn` (apps/web), which `/settings/billing` and
 * `/redeem` both mount. Deliberately NOT folded into `SETTINGS_EVENTS`: that would force a
 * `settings_*` name onto an event that fires on `/redeem`.
 */

/**
 * ⚠ THE CANONICAL SURFACE TUPLE — the hook's `surface` option types from this, so a mounting
 * surface and an analytics dimension cannot drift. A third surface adopting the hook extends
 * this tuple (and must first satisfy §F's "keeps unrelated query params" contract).
 */
export const STRIPE_REDIRECT_SURFACES = ['settings', 'redeem'] as const;
export type StripeRedirectSurface = (typeof STRIPE_REDIRECT_SURFACES)[number];

/**
 * Why a return in the URL did not bind to this tab.
 *  · `no_binding`       — params present, this tab recorded nothing. The headline case: a real
 *                         3DS return whose `sessionStorage` the browser dropped across the round
 *                         trip (in-app browsers, a bank-app deep link landing in a fresh tab,
 *                         some Android WebViews) — indistinguishable from a crafted link, which
 *                         is exactly why the answer is an event rather than a UI change.
 *  · `id_mismatch`      — this tab recorded a DIFFERENT SetupIntent. Crafted link, or a second
 *                         capture started before the first returned.
 *  · `duplicate_params` — ⚠ BAL-529 SCOPE ADDITION, not in the ticket's two-value list. A
 *                         duplicated `setup_intent`/`setup_intent_client_secret` is the A2
 *                         `return_url`-poisoning signature; `readSetupIntentReturnParams` fails
 *                         CLOSED on it, so under the ticket's stated trigger it would have been
 *                         the one unbound shape that fires NOTHING. Silence on the attack-shaped
 *                         case would have been the worst of the three.
 */
export const STRIPE_REDIRECT_UNBOUND_REASONS = [
  'no_binding',
  'id_mismatch',
  'duplicate_params',
] as const;
export type StripeRedirectUnboundReason = (typeof STRIPE_REDIRECT_UNBOUND_REASONS)[number];

export const STRIPE_REDIRECT_EVENTS = {
  /**
   * A SetupIntent redirect return arrived in the URL but did not bind to this tab. ⚠ NO PARAM
   * VALUES, NO IDS, EVER — §B exists precisely to keep those out of PostHog.
   */
  RETURN_UNBOUND: 'stripe_redirect_return_unbound',
} as const;

export interface StripeRedirectEventMap {
  [STRIPE_REDIRECT_EVENTS.RETURN_UNBOUND]: {
    surface: StripeRedirectSurface;
    reason: StripeRedirectUnboundReason;
  };
}
