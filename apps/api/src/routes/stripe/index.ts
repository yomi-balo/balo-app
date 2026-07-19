import type { FastifyInstance } from 'fastify';
import rawBody from 'fastify-raw-body';
import { stripeWebhookRoutes } from './webhook.js';
import { stripeSetupIntentRoutes } from './setup-intent.js';

/**
 * Stripe route plugin (BAL-382 / BAL-383). Registers `fastify-raw-body` PER-ROUTE and
 * encapsulated — `global: false` + `routes: ['/webhooks/stripe']` — so raw-body capture is
 * limited to the webhook route and never corrupts the JSON body parsing of every other
 * route (skill gotcha #2). `encoding: false` yields a Buffer, which `constructEvent` verifies
 * against the raw bytes.
 *
 * `stripeSetupIntentRoutes` (BAL-383 continue-to-mandate seam) is a plain JSON route — it is
 * deliberately NOT in the raw-body `routes` list, so it parses JSON normally.
 */
export async function stripeRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
    routes: ['/webhooks/stripe'],
  });
  await fastify.register(stripeWebhookRoutes);
  await fastify.register(stripeSetupIntentRoutes);
}
