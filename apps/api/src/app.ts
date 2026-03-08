import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as Sentry from '@sentry/node';
import { payoutsRoutes } from './routes/payouts/index.js';

export async function buildApp(opts?: { logger?: boolean }) {
  const fastify = Fastify({ logger: opts?.logger ?? true });

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
  await fastify.register(payoutsRoutes);

  return fastify;
}
