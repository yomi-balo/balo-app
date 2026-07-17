import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as Sentry from '@sentry/node';
import { notificationsRoutes } from './routes/notifications/index.js';
import { payoutsRoutes } from './routes/payouts/index.js';
import { phoneRoutes } from './routes/phone/index.js';
import { calendarRoutes } from './routes/calendar/index.js';
import { expertsRoutes } from './routes/experts/index.js';
import { stripeRoutes } from './routes/stripe/index.js';
import { creditRoutes } from './routes/credit/index.js';

export async function buildApp(opts?: { logger?: boolean }) {
  // `trustProxy: 1` trusts exactly one proxy hop (the Railway edge), so
  // `request.ip` is the real client IP rather than an attacker-injected
  // X-Forwarded-For entry. `trustProxy: true` would trust the entire
  // client-supplied XFF chain, letting a scraper spoof IPs and bypass the
  // per-IP rate limit on the public /experts/search endpoint. If Railway's
  // topology ever adds more proxy hops, revisit this hop count.
  const fastify = Fastify({ logger: opts?.logger ?? true, trustProxy: 1 });

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
  // Internal credit intent-creation routes (BAL-377) — secret-gated (requireInternalAuth).
  await fastify.register(creditRoutes);

  // Dev-only seed routes (BAL-239). Guarded dynamic import so the seed service
  // and @faker-js/faker never load in production.
  if (process.env.NODE_ENV !== 'production') {
    const { devRoutes } = await import('./routes/dev/index.js');
    await fastify.register(devRoutes);
  }

  return fastify;
}
