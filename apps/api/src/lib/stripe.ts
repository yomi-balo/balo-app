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
 *
 * ⚠ BAL-527 — `maxNetworkRetries: 2` IS NOW LOAD-BEARING, NOT JUST "SAFE". stripe-node retries
 * on an HTTP `409 idempotency_error` ("another in-progress request using this Idempotency Key"),
 * verified in the installed SDK's `RequestSender.js` (`if (res.getStatusCode() === 409) return
 * true;`). `createSetupIntent`'s mandate SetupIntent create carries a STABLE key as of BAL-527,
 * so two genuinely concurrent presses against the same wallet (React StrictMode's double-invoke
 * in `next dev`, or a real double-click) now make the second request 409 instead of minting a
 * second SetupIntent — and it is this retry, with exponential backoff + jitter, that lets the
 * second request converge on the first's replayed result instead of surfacing an error. DROPPING
 * OR ZEROING `maxNetworkRetries` WOULD SURFACE `StripeIdempotencyError` ON EVERY STRICTMODE PANEL
 * OPEN IN DEV. If both retries are exhausted (the sibling request took longer than ~1.5s), the
 * `409` propagates and `createSetupIntent`'s existing catch handles it exactly like any other
 * Stripe fault — no new branch.
 *
 * ⚠ FIX ROUND (review LOW) — THAT 409 RETRY IS CONDITIONAL ON STRIPE'S OWN HEADER, so the
 * guarantee rests on the vendor as well as the SDK. `RequestSender._shouldRetry` checks
 * `stripe-should-retry` FIRST (`RequestSender.js:170-172`) and returns `false` outright when the
 * response carries `'false'`, BEFORE it ever reaches the 409 branch (`:176-177`). Whether Stripe
 * sets that header on an in-flight-key conflict is the vendor's behaviour and nothing in this
 * repo pins it. So state the property as "stripe-node retries a 409 UNLESS Stripe tells it not
 * to", never as an unconditional guarantee of the SDK — and note that if Stripe ever did send it
 * here, the conflict would surface as the ordinary Stripe fault the catch already handles.
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
