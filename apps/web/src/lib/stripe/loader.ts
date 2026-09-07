import { loadStripe, type Stripe } from '@stripe/stripe-js';

/**
 * BAL-516 — the Map-cached Stripe.js loader, extracted from
 * `redeem/_components/continue-to-mandate.tsx` (was a local module-level `Map` there) so the
 * billing-settings capture panel doesn't mint a THIRD copy of this cache (Sonar duplication).
 *
 * BAL-529 §E — moved from `lib/stripe-loader.ts` into `lib/stripe/` (kebab-case domain name,
 * matching `setup-intent-return.ts`) and `TopUpComposer.tsx`'s own un-keyed module-level
 * singleton was folded into this cache — see its `stripePromise` `useMemo` for the re-wiring.
 * No `index.ts` barrel here: a barrel would pull the React hook into non-React module graphs,
 * so every module in this directory stays imported by concrete path.
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
