import Stripe from 'stripe';
import { StripeConfigError } from '../services/stripe/errors.js';

/**
 * Pinned Stripe API version (skill gotcha #1). NEVER float with the SDK default — a
 * silent bump can change webhook payload shapes. This literal is exactly the version
 * `stripe@22` ships as `Stripe.LatestApiVersion`, so it type-checks without a cast and
 * matches the version confirmed via the official `stripe-best-practices` skill.
 */
export const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2026-06-24.dahlia';

let stripeSingleton: Stripe | null = null;

/**
 * The lazily-constructed Stripe SDK singleton. Deferred (not a module-level `const`) so
 * merely importing this module never constructs a client — the SDK constructor THROWS on
 * a missing key, which would crash the shared Fastify app builder (and every route test)
 * at import time when `STRIPE_SECRET_KEY` is unset. Construction happens on first real use.
 *
 * Single env var (Decision E / ADR-1026): the VALUE is `sk_test_…` in dev/staging and
 * `sk_live_…` in prod, set per-environment in Railway/Vercel. No `_PROD`/`_TEST` branching
 * in code. `maxNetworkRetries: 2` is idempotency-safe (Stripe dedupes on the idempotency
 * key). Uses the classic `Customer` API, not Accounts v2 / `customer_account` (skill #5).
 */
export function getStripeClient(): Stripe {
  if (stripeSingleton !== null) {
    return stripeSingleton;
  }
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new StripeConfigError('STRIPE_SECRET_KEY is not set');
  }
  stripeSingleton = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
    maxNetworkRetries: 2,
  });
  return stripeSingleton;
}

/**
 * The per-endpoint, per-env webhook signing secret (`whsec_…`). Throws (not a `!`
 * assertion) so a misconfiguration is loud rather than a cryptic verification failure.
 */
export function getWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new StripeConfigError('STRIPE_WEBHOOK_SECRET is not set');
  }
  return secret;
}
