import { Worker, type Job } from 'bullmq';
import { calendarRepository } from '@balo/db';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { trackServer, CALENDAR_SERVER_EVENTS } from '@balo/analytics/server';

// ── Queue names ──────────────────────────────────────────────────

export const AVAILABILITY_CACHE_QUEUE = 'rebuild-availability-cache';
export const STALENESS_CHECK_QUEUE = 'staleness-check';

// ── Job data shapes ──────────────────────────────────────────────

export interface AvailabilityCacheJobData {
  expertProfileId: string;
}

// ── Worker: Rebuild availability cache ───────────────────────────

/**
 * Processes availability cache rebuild jobs.
 * Placeholder: updates the timestamp. Full calculation deferred to BAL-195 pt.2.
 */
export function startAvailabilityCacheWorker(): Worker<AvailabilityCacheJobData> {
  const worker = new Worker<AvailabilityCacheJobData>(
    AVAILABILITY_CACHE_QUEUE,
    async (job: Job<AvailabilityCacheJobData>) => {
      const { expertProfileId } = job.data;

      // Placeholder: update the cache timestamp only.
      // Full earliest_available_at calculation requires free/busy + availability rules
      // which will be implemented in BAL-195 pt.2.
      await calendarRepository.upsertAvailabilityCache(expertProfileId, null);

      trackServer(CALENDAR_SERVER_EVENTS.AVAILABILITY_CACHE_REBUILT, {
        distinct_id: expertProfileId,
      });

      job.log(`Availability cache updated for expert ${expertProfileId} (placeholder)`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    }
  );

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
            removeOnFail: false,
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
