import * as Sentry from '@sentry/node';
import { buildApp } from './app.js';
import { startWorkers } from './jobs/worker.js';
import { assertNoShowFloorOverrideUnsetInProduction } from './config/billing-floor.js';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 1.0,
});

const app = await buildApp();

try {
  // BAL-466 (D13) — ⚠⚠ THROWS IN PRODUCTION IF `MEETING_NO_SHOW_FLOOR_MINUTES` IS SET. Unlike
  // the two vendor-secret warnings below, this one is a HARD failure on purpose — an override
  // here would silently corrupt a MONEY figure (see the function's own docblock) rather than
  // degrade a feature, so crash-looping loudly is the correct trade. Run before `app.listen` so
  // a misconfigured deployment never starts serving traffic on it.
  assertNoShowFloorOverrideUnsetInProduction();

  await app.listen({
    port: parseInt(process.env.PORT || '3002'),
    host: '0.0.0.0',
  });

  try {
    await startWorkers(app.log);
  } catch (workerErr) {
    app.log.error(workerErr, 'BullMQ workers failed to start (server continues)');
  }

  // BAL-134 — ⚠ A WARNING, NOT AN ASSERTION, AND BOTH HALVES OF THAT ARE DELIBERATE.
  //
  // `recipient: 'admin'` rules resolve to the literal `OPS_NOTIFICATION_EMAIL`, and when it is
  // unset the dispatcher log.warns and SILENTLY SKIPS the send. That is fine for an FYI and NOT
  // fine for BAL-134's expert-absent alert, which exists precisely because Balo has committed
  // to contacting an expert who did not turn up — unset means nobody is told, and nothing
  // anywhere says so at the moment it matters. One line at boot makes the gap visible in Axiom
  // before a consultation depends on it.
  //
  // ⚠ IT MUST NOT BE A HARD FAILURE: throwing here would CRASH-LOOP Railway on a missing
  // notification address, taking down every route to protect one alert.
  if (!process.env.OPS_NOTIFICATION_EMAIL) {
    app.log.warn(
      'OPS_NOTIFICATION_EMAIL is not set — every `recipient: admin` notification will be SILENTLY SKIPPED, including the BAL-134 expert-absent salvage alert'
    );
  }

  // BAL-134 — THE SYMMETRIC WARNING, and it is arguably the more urgent of the two. Unset,
  // `POST /webhooks/daily` answers `503` to EVERY delivery, so presence degrades from
  // sub-second webhooks to ≤60s sweep reconciliation on a MONEY input — and the only party who
  // can see it happening is Daily, whose retries eventually disable the webhook altogether.
  // Nothing on Balo's side logs a thing, because nothing arrives.
  //
  // ⚠ A WARNING, NOT AN ASSERTION, for the same reason as above: throwing would crash-loop
  // Railway on a missing vendor secret and take down every route to protect one integration.
  if (!process.env.DAILY_WEBHOOK_SECRET) {
    app.log.warn(
      'DAILY_WEBHOOK_SECRET is not set — POST /webhooks/daily will 503 EVERY delivery, silently degrading meeting presence to sweep-only reconciliation until Daily disables the webhook'
    );
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
