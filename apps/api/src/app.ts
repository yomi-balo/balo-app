import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as Sentry from '@sentry/node';
import { log as sharedLogger } from '@balo/shared/logging';
import { notificationsRoutes } from './routes/notifications/index.js';
import { payoutsRoutes } from './routes/payouts/index.js';
import { phoneRoutes } from './routes/phone/index.js';
import { calendarRoutes } from './routes/calendar/index.js';
import { expertsRoutes } from './routes/experts/index.js';
import { stripeRoutes } from './routes/stripe/index.js';
import { sessionsRoutes } from './routes/sessions/index.js';
import { creditRoutes } from './routes/credit/index.js';
import { meetingsRoutes } from './routes/meetings/index.js';
import { dailyRoutes } from './routes/daily/index.js';
import { muxRoutes } from './routes/mux/index.js';

export async function buildApp(opts?: { logger?: boolean }) {
  // `trustProxy: 1` trusts exactly one proxy hop (the Railway edge), so
  // `request.ip` is the real client IP rather than an attacker-injected
  // X-Forwarded-For entry. `trustProxy: true` would trust the entire
  // client-supplied XFF chain, letting a scraper spoof IPs and bypass the
  // per-IP rate limit on the public /experts/search endpoint. If Railway's
  // topology ever adds more proxy hops, revisit this hop count.
  // Fastify's DEFAULT logger (`logger: true`) is a bare pino writing to stdout — it does NOT
  // carry the `@axiomhq/pino` transport or the REDACT_PATHS that `@balo/shared/logging`
  // configures. That split meant service logs (`createLogger('stripe')`, …) reached Axiom while
  // Fastify's own request logs AND the 500s captured by the error handler below did not: a
  // request that blew up was searchable nowhere. Passing the shared instance puts both on one
  // pipeline, and applies the redaction to request logs too.
  // `??` (not `||`) so tests passing `logger: false` still get a silent app.
  const fastify = Fastify({ logger: opts?.logger ?? sharedLogger, trustProxy: 1 });

  await fastify.register(cors, {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  });

  fastify.setErrorHandler((error, request, reply) => {
    Sentry.captureException(error);
    fastify.log.error(error);
    reply.status(500).send({ error: 'Internal Server Error' });
  });

  fastify.get('/health', async () => {
    return { status: 'ok' };
  });

  // Feature routes
  await fastify.register(notificationsRoutes);
  await fastify.register(payoutsRoutes);
  await fastify.register(phoneRoutes);
  await fastify.register(calendarRoutes);
  // Public, unauthenticated, rate-limited expert search (BAL-246).
  await fastify.register(expertsRoutes);
  // Stripe client-charging webhook (BAL-382) — raw-body scoped inside this plugin.
  await fastify.register(stripeRoutes);
  // Credit-session drawdown / overdraft routes (BAL-378).
  await fastify.register(sessionsRoutes);
  // Internal credit intent-creation routes (BAL-377) — secret-gated (requireInternalAuth).
  await fastify.register(creditRoutes);
  // Meeting booking + Daily room provisioning (BAL-129). Ships INERT — no live producer
  // until BAL-400's booking UI calls it.
  await fastify.register(meetingsRoutes);
  // BAL-134 — the Daily presence webhook. Raw-body scoped INSIDE this plugin, exactly as the
  // Stripe one is; a global registration would corrupt JSON parsing on every other route.
  await fastify.register(dailyRoutes);
  // BAL-473 — the Mux ingest webhook (video.asset.ready / video.asset.errored). Own raw-body
  // scope, own rate-limit budget — nothing inherited from the Daily or Stripe plugins.
  await fastify.register(muxRoutes);

  // Dev-only seed routes (BAL-239). Guarded dynamic import so the seed service
  // and @faker-js/faker never load in production.
  if (process.env.NODE_ENV !== 'production') {
    const { devRoutes } = await import('./routes/dev/index.js');
    await fastify.register(devRoutes);
  }

  return fastify;
}
