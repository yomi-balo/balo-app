import type { FastifyInstance } from 'fastify';
import rawBody from 'fastify-raw-body';
import { muxWebhookRoutes } from './webhook.js';

/**
 * BAL-473 (§8.1) — the Mux route plugin. Mirrors `routes/daily/index.ts` (itself copied from
 * `routes/stripe/index.ts`) — its OWN `fastify-raw-body` registration, nothing inherited from
 * either sibling plugin.
 *
 * ⚠⚠ `fastify-raw-body` IS REGISTERED **SCOPED** — `global: false` plus an explicit `routes`
 * allow-list — so raw-body capture applies to `/webhooks/mux` and NOTHING ELSE. A global
 * registration corrupts JSON body parsing on every other route in the app.
 *
 * ⚠ `encoding: false` YIELDS A `Buffer`. The signature covers the RAW BYTES; a string decode
 * plus re-encode is not guaranteed to reproduce them.
 *
 * ⚠ `runFirst: true` so the raw body is captured before any other content-type parser sees it.
 *
 * Routes carry NO PREFIX (`app.ts` registers plugins bare), so the path is literally
 * `/webhooks/mux`, matching `/webhooks/daily` and `/webhooks/stripe`.
 */
export async function muxRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
    routes: ['/webhooks/mux'],
  });
  await fastify.register(muxWebhookRoutes);
}
