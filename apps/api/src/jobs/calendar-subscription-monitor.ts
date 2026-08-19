import { Worker, type Job } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { calendarSubscriptionsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { trackServer, CALENDAR_SERVER_EVENTS } from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { notificationEvents } from '../notifications/publisher.js';
import { resolveWebhookBaseUrl } from '../services/calendar/webhook-url.js';
import { SUBSCRIPTION_RENEWAL_LEAD_MS } from '../services/calendar/subscription-plan.js';
import { enqueueSubscriptionReconcile } from './calendar-subscription-reconcile.js';
import { PROBE_INTERVAL_MS } from './calendar-health-probe.js';

const log = createLogger('calendar-subscription-monitor');

/**
 * BAL-468 §12 — the daily expiry monitor + internal ops alert. It runs even when the
 * reconciler is SKIPPING (connection not ACTIVE, feature unconfigured, probe batch
 * saturated) — its job is to notice that repair is not happening, which no per-connection
 * sweep can see (arm 3 especially: a live ACTIVE connection with ZERO live subscriptions is
 * invisible to arms 1/2, which only scan `calendar_subscriptions`).
 */
export const CALENDAR_SUBSCRIPTION_MONITOR_QUEUE = 'calendar-subscription-monitor';
export const CALENDAR_SUBSCRIPTION_MONITOR_CRON = '0 7 * * *'; // daily 07:00 UTC — offset from
// dormancy 03:00, fx 05:00, dunning 09:00.

export const SUBSCRIPTION_EXPIRY_ALERT_MS = 48 * 60 * 60 * 1000;
export const SUBSCRIPTION_UNCONFIRMED_GRACE_MS = 2 * 60 * 60 * 1000;
export const SUBSCRIPTION_MONITOR_BATCH_LIMIT = 500;

/**
 * ⚠⚠ TWO COUPLED CONSTANTS, ASSERTED AT MODULE LOAD — house precedent:
 * `calendar-health-probe.ts` does the identical thing for `PROBE_INTERVAL_MS` vs
 * `STALENESS_CHECK_THRESHOLD_MS`, "so the coupling fails LOUDLY instead of silently if it is
 * ever inverted".
 *
 * The ladder: `PROBE_INTERVAL_MS (1h) ≪ SUBSCRIPTION_EXPIRY_ALERT_MS (48h) <
 * SUBSCRIPTION_RENEWAL_LEAD_MS (72h) ≪ vendor TTL (7d)`.
 *
 *  - Renew at 72h, alert at 48h. Equal (or inverted) thresholds would alert on every row the
 *    renewer is about to fix, every day, carrying no information. The 24h gap means a row
 *    reaching the alert threshold has had renewal FAILING for a full day.
 *  - Alert threshold ≫ probe interval: between a row entering the renewal window and reaching
 *    the alert threshold there are ~24 reconcile opportunities (one per probe tick). An alert
 *    firing sooner would measure the schedule, not the failure.
 */
if (SUBSCRIPTION_RENEWAL_LEAD_MS <= SUBSCRIPTION_EXPIRY_ALERT_MS) {
  throw new Error(
    `calendar-subscription-monitor: SUBSCRIPTION_RENEWAL_LEAD_MS (${SUBSCRIPTION_RENEWAL_LEAD_MS}ms) ` +
      `must stay strictly greater than SUBSCRIPTION_EXPIRY_ALERT_MS (${SUBSCRIPTION_EXPIRY_ALERT_MS}ms) ` +
      `— otherwise the monitor alerts on every row the renewer is about to fix, every day.`
  );
}
if (SUBSCRIPTION_EXPIRY_ALERT_MS <= PROBE_INTERVAL_MS) {
  throw new Error(
    `calendar-subscription-monitor: SUBSCRIPTION_EXPIRY_ALERT_MS (${SUBSCRIPTION_EXPIRY_ALERT_MS}ms) ` +
      `must stay strictly greater than PROBE_INTERVAL_MS (${PROBE_INTERVAL_MS}ms) — otherwise the ` +
      `alert fires before the reconciler has had a real chance to act.`
  );
}

/** A `FastifyBaseLogger`-shaped adapter over the scoped Pino logger, matching the health
 *  probe's identical need to call `enqueueSubscriptionReconcile` outside a Fastify request. */
const enqueueLogger = log as unknown as FastifyBaseLogger;

export interface CalendarSubscriptionMonitorResult {
  expiringCount: number;
  unconfirmedCount: number;
  unsubscribedConnectionCount: number;
  alerted: boolean;
  selfHealed: number;
}

/** The sweep body (exported for unit testing without a Redis-backed Worker). */
export async function runCalendarSubscriptionMonitor(
  now: Date,
  jobLog: (message: string) => void = () => {}
): Promise<CalendarSubscriptionMonitorResult> {
  // ⚠⚠ ALL THREE ARMS ARE GATED, NOT JUST ARM 3 — and the reason is the REVERT path, not
  // merge day. §17's documented revert is "unset APIROC_WEBHOOK_BASE_URL and redeploy", which
  // it calls safe and quiet. With only arm 3 gated it is neither: the rows STAY in the table,
  // every reconcile returns `webhook_not_configured`, and within days every row crosses the
  // 48h threshold. Arm 1 then fires `apiroc_subscription_expiry_alert` at ERROR level plus an
  // `admin_users` notification, daily, forever — with a self-heal that provably cannot repair
  // anything, because the thing it would enqueue is the reconcile that is switched off. The
  // documented recovery procedure would manufacture permanent alert fatigue on the one paging
  // signal this feature has.
  //
  // Arm 3 additionally needs the gate for the merge-day reason: before the on-switch is ever
  // thrown, EVERY ACTIVE connection legitimately has zero subscriptions.
  const featureConfigured = resolveWebhookBaseUrl() !== null;
  if (!featureConfigured) {
    const result: CalendarSubscriptionMonitorResult = {
      expiringCount: 0,
      unconfirmedCount: 0,
      unsubscribedConnectionCount: 0,
      alerted: false,
      selfHealed: 0,
    };
    log.warn({ reason: 'feature_disabled' }, 'apiroc_subscription_monitor_skipped');
    jobLog('calendar subscription monitor: feature not configured — no reads, no alerts');
    return result;
  }

  const expiring = await calendarSubscriptionsRepository.listExpiringBefore(
    new Date(now.getTime() + SUBSCRIPTION_EXPIRY_ALERT_MS),
    SUBSCRIPTION_MONITOR_BATCH_LIMIT
  );
  if (expiring.length === SUBSCRIPTION_MONITOR_BATCH_LIMIT) {
    log.warn(
      { arm: 'expiring', limit: SUBSCRIPTION_MONITOR_BATCH_LIMIT },
      'apiroc_subscription_monitor_batch_filled'
    );
  }

  const unconfirmed = await calendarSubscriptionsRepository.listUnconfirmedBefore(
    new Date(now.getTime() - SUBSCRIPTION_UNCONFIRMED_GRACE_MS),
    SUBSCRIPTION_MONITOR_BATCH_LIMIT
  );
  if (unconfirmed.length === SUBSCRIPTION_MONITOR_BATCH_LIMIT) {
    log.warn(
      { arm: 'unconfirmed', limit: SUBSCRIPTION_MONITOR_BATCH_LIMIT },
      'apiroc_subscription_monitor_batch_filled'
    );
  }

  // Arm 3. The feature-configured gate that used to sit here now guards the whole sweep
  // above — see its docblock.
  const unsubscribed =
    await calendarSubscriptionsRepository.listActiveConnectionsWithoutSubscription(
      SUBSCRIPTION_MONITOR_BATCH_LIMIT
    );
  if (unsubscribed.length === SUBSCRIPTION_MONITOR_BATCH_LIMIT) {
    log.warn(
      { arm: 'unsubscribed', limit: SUBSCRIPTION_MONITOR_BATCH_LIMIT },
      'apiroc_subscription_monitor_batch_filled'
    );
  }

  // Self-heal: enqueue a reconcile for every distinct connection found in arrears. This never
  // suppresses the alert below — "renewal was late" is information even after a repair attempt.
  const connectionIds = new Set<string>();
  for (const row of expiring) connectionIds.add(row.connectionId);
  for (const row of unconfirmed) connectionIds.add(row.connectionId);
  for (const row of unsubscribed) connectionIds.add(row.connectionId);
  for (const connectionId of connectionIds) {
    await enqueueSubscriptionReconcile(connectionId, { force: false }, enqueueLogger);
  }

  const result: CalendarSubscriptionMonitorResult = {
    expiringCount: expiring.length,
    unconfirmedCount: unconfirmed.length,
    unsubscribedConnectionCount: unsubscribed.length,
    alerted: false,
    selfHealed: connectionIds.size,
  };

  // Alert on count > 0 in ANY arm, never on a threshold. If renewal works, the steady state
  // is zero.
  if (
    result.expiringCount === 0 &&
    result.unconfirmedCount === 0 &&
    result.unsubscribedConnectionCount === 0
  ) {
    jobLog('calendar subscription monitor: all arms clean');
    return result;
  }

  result.alerted = true;

  // ⚠ THIS LOG LINE, not the notification, is the paging signal. It reaches Axiom and Sentry.
  log.error(
    {
      expiringCount: result.expiringCount,
      unconfirmedCount: result.unconfirmedCount,
      unsubscribedConnectionCount: result.unsubscribedConnectionCount,
      sampleExpiringIds: expiring.slice(0, 5).map((r) => r.id),
      sampleUnconfirmedIds: unconfirmed.slice(0, 5).map((r) => r.id),
    },
    'apiroc_subscription_expiry_alert'
  );

  trackServer(CALENDAR_SERVER_EVENTS.SUBSCRIPTION_LAPSE_DETECTED, {
    expiring_count: result.expiringCount,
    unconfirmed_count: result.unconfirmedCount,
    unsubscribed_connection_count: result.unsubscribedConnectionCount,
    distinct_id: 'system:calendar-subscriptions',
  });

  // Feature code publishes an event; it NEVER sends email directly.
  const correlationId = `calendar_subscription_lapse:${now.toISOString().slice(0, 10)}`;
  try {
    await notificationEvents.publish('calendar.subscription_lapse', {
      correlationId,
      expiringCount: result.expiringCount,
      unconfirmedCount: result.unconfirmedCount,
      unsubscribedConnectionCount: result.unsubscribedConnectionCount,
    });
  } catch (err: unknown) {
    log.error(
      { correlationId, error: err instanceof Error ? err.message : String(err) },
      'Failed to publish calendar.subscription_lapse notification event'
    );
  }

  jobLog(
    `calendar subscription monitor: ALERT — expiring=${result.expiringCount} ` +
      `unconfirmed=${result.unconfirmedCount} unsubscribed=${result.unsubscribedConnectionCount} ` +
      `selfHealed=${result.selfHealed}`
  );
  return result;
}

/** `concurrency: 1` — house precedent, every job in `jobs/` is serial. */
export function startCalendarSubscriptionMonitorWorker(): Worker {
  return new Worker(
    CALENDAR_SUBSCRIPTION_MONITOR_QUEUE,
    async (job: Job) => {
      await runCalendarSubscriptionMonitor(new Date(), (m) => job.log(m));
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the daily 07:00 UTC monitor sweep. */
export async function registerCalendarSubscriptionMonitorCron(): Promise<void> {
  const queue = getQueue(CALENDAR_SUBSCRIPTION_MONITOR_QUEUE);
  await queue.add(
    'monitor',
    {},
    {
      repeat: { pattern: CALENDAR_SUBSCRIPTION_MONITOR_CRON },
      removeOnComplete: true,
    }
  );
}
