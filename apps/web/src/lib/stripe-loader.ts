import { loadStripe, type Stripe } from '@stripe/stripe-js';

/**
 * BAL-516 — the Map-cached Stripe.js loader, extracted from
 * `redeem/_components/continue-to-mandate.tsx` (was a local module-level `Map` there) so the
 * billing-settings capture panel doesn't mint a THIRD copy of this cache (Sonar duplication).
 *
 * ⚠ FIX ROUND (review MINOR) — `TopUpComposer.tsx` keeps its OWN un-keyed module-level singleton
 * over the SAME `@stripe/stripe-js` `loadStripe` import (not, as an earlier draft of this comment
 * claimed, through some separate `@stripe/react-stripe-js`-owned loader — that package exports no
 * `loadStripe` at all). Folding that singleton into this cache is a follow-up, out of this
 * ticket's scope, not a settled architectural difference.
 *
 * Behaviour-preserving: same Map-per-key memoisation, same `loadStripe` call, so
 * `continue-to-mandate.test.tsx` needs no change.
 *
 * Memoised per publishable key — calling `loadStripe` on every render would re-inject Stripe's
 * script tag. A `Map` keyed on the key keeps a single promise per key alive for the module's
 * lifetime (there is only ever one publishable key per environment in practice).
 */
const stripeLoaderCache = new Map<string, Promise<Stripe | null>>();

export function getStripe(publishableKey: string): Promise<Stripe | null> {
  const cached = stripeLoaderCache.get(publishableKey);
  if (cached !== undefined) {
    return cached;
  }
  const created = loadStripe(publishableKey);
  stripeLoaderCache.set(publishableKey, created);
  return created;
}
