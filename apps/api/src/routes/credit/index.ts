import type { FastifyInstance } from 'fastify';
import { purchaseIntentRoute } from './purchase-intent.js';
import { setupIntentRoute } from './setup-intent.js';
import { paymentMethodRoute } from './payment-method.js';
import { billingEmailRoute } from './billing-email.js';

/**
 * Internal credit routes (BAL-377 / ADR-1040 Lane 1). All are secret-gated
 * (`requireInternalAuth`, per route) and exist because the Stripe provider layer +
 * `STRIPE_SECRET_KEY` live on apps/api — apps/web delegates intent-creation here over the
 * established internal-secret hop (the `/notifications/publish` precedent). apps/web owns
 * authz + wallet resolution + config persistence + analytics; apps/api owns the Stripe SDK.
 *
 * BAL-516 — `paymentMethodRoute` adds `POST /credit/payment-method/detach`, the outbound half
 * of card removal (BAL-515 shipped only the inbound webhook half).
 *
 * BAL-522 — `billingEmailRoute` adds `POST /credit/billing-email`, the whole write path for an
 * explicit billing-email change (D1: one app owns every write to those columns).
 */
export async function creditRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(purchaseIntentRoute);
  await fastify.register(setupIntentRoute);
  await fastify.register(paymentMethodRoute);
  await fastify.register(billingEmailRoute);
}
