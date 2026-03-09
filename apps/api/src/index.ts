import * as Sentry from '@sentry/node';
import { buildApp } from './app.js';
import { startWorkers } from './jobs/worker.js';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 1.0,
});

const app = await buildApp();

try {
  await app.listen({
    port: parseInt(process.env.PORT || '3002'),
    host: '0.0.0.0',
  });

  startWorkers(app.log);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
