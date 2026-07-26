import { Worker, type Job } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { calendarRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { trackServer, CALENDAR_SERVER_EVENTS } from '@balo/analytics/server';
import { resolveAndCacheAvailability } from '../services/availability/resolve-and-cache.js';

const log = createLogger('availability-cache-worker');

// ── Queue names ──────────────────────────────────────────────────

export const AVAILABILITY_CACHE_QUEUE = 'rebuild-availability-cache';
export const STALENESS_CHECK_QUEUE = 'staleness-check';

// ── Job data shapes ──────────────────────────────────────────────

export interface AvailabilityCacheJobData {
  expertProfileId: string;
}

// ── Enqueue helper ───────────────────────────────────────────────

/**
 * Enqueues a (deduplicated) availability-cache rebuild for one expert.
 *
 * Best-effort: a Redis hiccup must never fail the caller's mutation, so we
 * swallow and log any enqueue error. The `jobId` dedupes concurrent triggers
 * (webhook change + settings mutation) into a single pending rebuild.
 *
 * `removeOnFail: true` is deliberate: this is an idempotent cache-rebuild, and the
 * fixed per-expert `jobId` means a RETAINED failed job would block every later
 * enqueue for that expert (webhook, schedule-save, override change, staleness cron)
 * — permanently wedging their availability. Dropping the job on terminal failure
 * lets the next trigger self-heal. `attempts`/`backoff` absorb transient DB blips;
 * the worker's `failed` listener surfaces a terminal failure to logs/Sentry.
 *
 * Shared by the Cronofy webhook, the schedule editor, and the availability-override routes.
 */
export async function enqueueAvailabilityCacheRebuild(
  expertProfileId: string,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    const queue = getQueue(AVAILABILITY_CACHE_QUEUE);
    await queue.add(
      'rebuild-availability-cache',
      { expertProfileId } satisfies AvailabilityCacheJobData,
      {
        jobId: `availability-${expertProfileId}`,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      }
    );
  } catch (err: unknown) {
    log.error(
      { expertProfileId, error: err instanceof Error ? err.message : String(err) },
      'Failed to enqueue availability cache rebuild job'
    );
  }
}

// ── Worker: Rebuild availability cache ───────────────────────────

/**
 * Processes availability cache rebuild jobs.
 *
 * Delegates the heavy lifting to `resolveAndCacheAvailability` (load tz +
 * rules + confirmed consultations, run the pure resolver, upsert the cache).
 * The worker stays thin: invoke, emit analytics, log.
 *
 * BAL-243: `busyBlocks` defaults to `[]` inside the service — BAL-194/195
 * will wire Cronofy free/busy through this same call site.
 */
export function startAvailabilityCacheWorker(): Worker<AvailabilityCacheJobData> {
  const worker = new Worker<AvailabilityCacheJobData>(
    AVAILABILITY_CACHE_QUEUE,
    async (job: Job<AvailabilityCacheJobData>) => {
      const { expertProfileId } = job.data;

      await resolveAndCacheAvailability(expertProfileId);

      trackServer(CALENDAR_SERVER_EVENTS.AVAILABILITY_CACHE_REBUILT, {
        distinct_id: expertProfileId,
      });

      job.log(`Availability cache rebuilt for expert ${expertProfileId}`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    }
  );

  // Terminal failures used to be invisible: the enqueue swallows dropped duplicates,
  // and jobs now self-heal (removeOnFail: true) rather than lingering in Redis. This
  // listener is the failure signal — a rebuild that exhausts its attempts reaches
  // Axiom/Sentry instead of silently leaving `earliest_available_at` stale.
  worker.on('failed', (job, err) => {
    log.error(
      {
        expertProfileId: job?.data.expertProfileId,
        attemptsMade: job?.attemptsMade,
        error: err.message,
      },
      'Availability cache rebuild job failed'
    );
  });

  return worker;
}

// ── Worker: Staleness check ──────────────────────────────────────

/**
 * Checks for stale calendar connections (no webhook in 15 minutes)
 * and enqueues rebuild jobs for each.
 */
export function startStalenessCheckWorker(): Worker {
  const worker = new Worker(
    STALENESS_CHECK_QUEUE,
    async (job: Job) => {
      const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);
      const staleConnections = await calendarRepository.findStaleConnections(staleThreshold);

      if (staleConnections.length === 0) {
        job.log('No stale connections found');
        return;
      }

      const queue = getQueue(AVAILABILITY_CACHE_QUEUE);

      for (const conn of staleConnections) {
        await queue.add(
          'rebuild-availability-cache',
          { expertProfileId: conn.expertProfileId } satisfies AvailabilityCacheJobData,
          {
            jobId: `availability-${conn.expertProfileId}`,
            removeOnComplete: true,
            // Self-heal on failure — a retained failed job would block this same
            // fixed jobId on every later trigger (see enqueue-rebuild.ts).
            removeOnFail: true,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
          }
        );
      }

      job.log(`Enqueued ${staleConnections.length} stale connection rebuild jobs`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );

  return worker;
}

// ── Cron registration ────────────────────────────────────────────

/**
 * Registers a repeating job that checks for stale connections every 15 minutes.
 */
export async function registerStalenessCheckCron(): Promise<void> {
  const queue = getQueue(STALENESS_CHECK_QUEUE);
  await queue.add(
    'check',
    {},
    {
      repeat: { pattern: '*/15 * * * *' },
      removeOnComplete: true,
    }
  );
}
