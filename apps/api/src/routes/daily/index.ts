import type { FastifyInstance } from 'fastify';
import rawBody from 'fastify-raw-body';
import { dailyWebhookRoutes } from './webhook.js';

/**
 * BAL-134 — the Daily route plugin. Copied from `routes/stripe/index.ts`, including its
 * reasoning:
 *
 * ⚠⚠ `fastify-raw-body` IS REGISTERED **SCOPED** — `global: false` plus an explicit `routes`
 * allow-list — so raw-body capture applies to the webhook and NOTHING ELSE. A global
 * registration corrupts JSON body parsing on every other route in the app (the skill's gotcha
 * #2), which would be a platform-wide failure introduced by a single feature's webhook.
 *
 * ⚠ `encoding: false` YIELDS A `Buffer`, AND THAT IS LOAD-BEARING RATHER THAN A DETAIL. The
 * signature covers the RAW BYTES; a string decode plus re-encode is not guaranteed to reproduce
 * them, and `JSON.parse` + `JSON.stringify` certainly does not (key order, whitespace) — which
 * `webhook-signature.test.ts` pins with a key-order case.
 *
 * ⚠ `runFirst: true` so the raw body is captured before any other content-type parser sees it.
 */
export async function dailyRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
    routes: ['/webhooks/daily'],
  });
  await fastify.register(dailyWebhookRoutes);
}
