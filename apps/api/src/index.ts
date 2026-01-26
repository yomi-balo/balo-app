import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 1.0,
});

const fastify = Fastify({ logger: true });

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

try {
  await fastify.listen({
    port: parseInt(process.env.PORT || '3001'),
    host: '0.0.0.0',
  });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
