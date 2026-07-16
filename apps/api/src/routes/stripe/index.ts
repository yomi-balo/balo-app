import type { FastifyInstance } from 'fastify';
import rawBody from 'fastify-raw-body';
import { stripeWebhookRoutes } from './webhook.js';

/**
 * Stripe route plugin (BAL-382). Registers `fastify-raw-body` PER-ROUTE and encapsulated —
 * `global: false` + `routes: ['/webhooks/stripe']` — so raw-body capture is limited to this
 * plugin scope and never corrupts the JSON body parsing of every other route (skill gotcha
 * #2). `encoding: false` yields a Buffer, which `constructEvent` verifies against the raw
 * bytes.
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
}
