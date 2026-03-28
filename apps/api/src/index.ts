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

  try {
    await startWorkers(app.log);
  } catch (workerErr) {
    app.log.error(workerErr, 'BullMQ workers failed to start (server continues)');
  }
  const shutdown = async () => {
    try {
      const { shutdownServerAnalytics } = await import('@balo/analytics/server');
      await shutdownServerAnalytics();
    } catch (err) {
      app.log.error(err, 'Failed to flush PostHog events on shutdown');
    }
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
