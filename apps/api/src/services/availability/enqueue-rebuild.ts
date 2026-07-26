import type { FastifyBaseLogger } from 'fastify';
import { getQueue } from '../../lib/queue.js';
import { AVAILABILITY_CACHE_QUEUE } from '../../jobs/availability-cache.js';

/**
 * Enqueue a BullMQ job to rebuild an expert's availability cache.
 *
 * Shared by the Cronofy webhook (`routes/calendar/webhook.ts`) and the
 * schedule editor (`routes/experts/schedule.ts`). Reusing the SAME `jobId`
 * (`availability-${expertProfileId}`) is deliberate — it coalesces a
 * schedule-save rebuild with a concurrent webhook rebuild into one job.
 *
 * Enqueue failure is logged, never thrown: a missed rebuild leaves a stale
 * `earliest_available_at` but must not fail the caller's request. Extracted to
 * one place so the ~15-line body isn't duplicated (SonarCloud new-code
 * duplication gate).
 *
 * `removeOnFail: true` is deliberate: this is an idempotent cache-rebuild, and the
 * fixed per-expert `jobId` means a RETAINED failed job would block every later
 * enqueue for that expert (webhook, schedule-save, staleness cron) — permanently
 * wedging their availability. Dropping the job on terminal failure lets the next
 * trigger self-heal. `attempts`/`backoff` first absorb transient DB blips; the
 * worker's `failed` listener is what surfaces a terminal failure to logs/Sentry.
 */
export async function enqueueAvailabilityCacheRebuild(
  expertProfileId: string,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    const queue = getQueue(AVAILABILITY_CACHE_QUEUE);
    await queue.add(
      'rebuild-availability-cache',
      { expertProfileId },
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
