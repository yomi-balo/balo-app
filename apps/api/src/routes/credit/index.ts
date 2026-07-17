import type { FastifyInstance } from 'fastify';
import { purchaseIntentRoute } from './purchase-intent.js';
import { setupIntentRoute } from './setup-intent.js';

/**
 * Internal credit routes (BAL-377 / ADR-1040 Lane 1). Both are secret-gated
 * (`requireInternalAuth`, per route) and exist because the Stripe provider layer +
 * `STRIPE_SECRET_KEY` live on apps/api — apps/web delegates intent-creation here over the
 * established internal-secret hop (the `/notifications/publish` precedent). apps/web owns
 * authz + wallet resolution + config persistence + analytics; apps/api owns the Stripe SDK.
 */
export async function creditRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(purchaseIntentRoute);
  await fastify.register(setupIntentRoute);
}
