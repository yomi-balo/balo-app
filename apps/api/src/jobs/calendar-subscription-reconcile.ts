import { Worker, type Job } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { calendarRepository } from '@balo/db';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { reconcileConnectionSubscriptions } from '../services/calendar/subscription-reconcile.js';

/**
 * BAL-468 §8.4 — the subscription-reconciliation worker. Trigger-driven, no cron of its own:
 * six enqueue sites (three on the health probe, the OAuth callback, the conflict-check
 * toggle, and the monitor's self-heal) push work here instead of the probe running vendor
 * calls inline on its own tick — see `jobs/calendar-health-probe.ts`'s docblock for why.
 */
export const CALENDAR_SUBSCRIPTION_RECONCILE_QUEUE = 'calendar-subscription-reconcile';

export interface CalendarSubscriptionReconcileJobData {
  readonly connectionId: string;
  readonly force: boolean;
}

/**
 * Best-effort enqueue, matching `enqueueAvailabilityCacheRebuild` — a Redis hiccup must never
 * fail an OAuth callback or a toggle.
 *
 * ⚠⚠ THE TWO JOBID LANES ARE LOAD-BEARING. With a single lane, a pending non-force job would
 * swallow a later `force` enqueue and the connection would never get its forced post-reconnect
 * renewal — a silent correctness hole. `concurrency: 1` serialises both lanes anyway.
 */
export async function enqueueSubscriptionReconcile(
  connectionId: string,
  options: { readonly force: boolean },
  log: FastifyBaseLogger
): Promise<void> {
  try {
    const queue = getQueue(CALENDAR_SUBSCRIPTION_RECONCILE_QUEUE);
    await queue.add(
      'reconcile',
      { connectionId, force: options.force } satisfies CalendarSubscriptionReconcileJobData,
      {
        jobId: `subscriptions-${options.force ? 'force-' : ''}${connectionId}`,
        removeOnComplete: true,
        // A RETAINED failed job under a fixed jobId would block every later enqueue for this
        // connection — the same wedging argument as the availability queue's docblock.
        removeOnFail: true,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      }
    );
  } catch (err: unknown) {
    log.error(
      {
        connectionId,
        force: options.force,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to enqueue calendar subscription reconcile job'
    );
  }
}

/** `concurrency: 1` — house precedent, every job in `jobs/` is serial. */
export function startCalendarSubscriptionReconcileWorker(): Worker<CalendarSubscriptionReconcileJobData> {
  return new Worker<CalendarSubscriptionReconcileJobData>(
    CALENDAR_SUBSCRIPTION_RECONCILE_QUEUE,
    async (job: Job<CalendarSubscriptionReconcileJobData>) => {
      const { connectionId, force } = job.data;
      const connection = await calendarRepository.findConnectionById(connectionId);
      if (connection === undefined) {
        job.log(`calendar subscription reconcile: connection ${connectionId} is gone — skipping`);
        return;
      }
      const outcome = await reconcileConnectionSubscriptions(connection, { force });
      job.log(
        `calendar subscription reconcile: connection ${connectionId} — ` +
          `skipped=${outcome.skipped ?? 'no'} created=${outcome.created} renewed=${outcome.renewed} ` +
          `deleted=${outcome.deleted} deleteFailures=${outcome.deleteFailures} ` +
          `unverifiedDeletes=${outcome.unverifiedDeletes} missingAtVendor=${outcome.missingAtVendor}`
      );
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}
