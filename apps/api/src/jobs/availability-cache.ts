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

/**
 * ⚠⚠ round-2 fix #8 — THIS CONSTANT AND `calendar-health-probe.ts`'s `PROBE_INTERVAL_MS` ARE
 * ONE COUPLED INVARIANT, NOT TWO INDEPENDENT NUMBERS. `findStaleConnections` below treats a
 * connection as stale once its `credential_checked_at` is older than this threshold — but
 * under NORMAL operation `credential_checked_at` is refreshed only once per
 * `PROBE_INTERVAL_MS` (the health probe's own re-probe cadence). If `PROBE_INTERVAL_MS` ever
 * drops to or below this threshold, every connection's `credential_checked_at` stays "fresh
 * enough" and `findStaleConnections` silently returns `[]` on every tick forever — the EXACT
 * permanent-no-op failure class this file's own docblock says round 1 just closed (the
 * `last_synced_at`-with-no-writer bug), re-armed by an unrelated tuning change in a different
 * file. `calendar-health-probe.ts` imports this constant and asserts the ordering at module
 * load — see its `PROBE_INTERVAL_MS` docblock — so the coupling fails LOUDLY instead of
 * silently if it is ever inverted.
 */
export const STALENESS_CHECK_THRESHOLD_MS = 15 * 60 * 1000;

// ── Job data shapes ──────────────────────────────────────────────

export interface AvailabilityCacheJobData {
  expertProfileId: string;
}

// ── Enqueue helper ───────────────────────────────────────────────

/**
 * BAL-468 §7.4 — the shared implementation. Returns `false` when the enqueue did not land.
 * The ONE caller that must know is the Apiroc webhook (`routes/calendar/webhook.ts`), which
 * answers 503 so the delivery stays in the vendor's retry queue instead of being acked into
 * the void — see `tryEnqueueAvailabilityCacheRebuild` below.
 *
 * `jobId`, `removeOnComplete`, `removeOnFail`, `attempts` and `backoff` live HERE and only
 * here — there must remain exactly ONE place those options are written.
 *
 * `removeOnFail: true` is deliberate: this is an idempotent cache-rebuild, and the
 * fixed per-expert `jobId` means a RETAINED failed job would block every later
 * enqueue for that expert (webhook, schedule-save, override change, staleness cron)
 * — permanently wedging their availability. Dropping the job on terminal failure
 * lets the next trigger self-heal. `attempts`/`backoff` absorb transient DB blips;
 * the worker's `failed` listener surfaces a terminal failure to logs/Sentry.
 */
async function enqueueRebuild(expertProfileId: string): Promise<void> {
  const queue = getQueue(AVAILABILITY_CACHE_QUEUE);
  await queue.add(
    'rebuild-availability-cache',
    { expertProfileId } satisfies AvailabilityCacheJobData,
    {
      // ⚠ Per-EXPERT, not per-calendar or per-subscription. The jobId string is load-bearing:
      // getting it wrong (e.g. `availability-${expertId}`) silently disables the dedupe.
      jobId: `availability-${expertProfileId}`,
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    }
  );
}

/**
 * Returns `false` when the enqueue did not land — the Apiroc webhook route is the one caller
 * that must know, so it can answer 503 and keep the delivery in Svix's retry queue rather than
 * acking a change it never scheduled a rebuild for.
 */
export async function tryEnqueueAvailabilityCacheRebuild(
  expertProfileId: string,
  log: FastifyBaseLogger
): Promise<boolean> {
  try {
    await enqueueRebuild(expertProfileId);
    return true;
  } catch (err: unknown) {
    log.error(
      { expertProfileId, error: err instanceof Error ? err.message : String(err) },
      'Failed to enqueue availability cache rebuild job'
    );
    return false;
  }
}

/**
 * Enqueues a (deduplicated) availability-cache rebuild for one expert.
 *
 * Best-effort: a Redis hiccup must never fail the caller's mutation, so this swallows and
 * logs any enqueue error via `tryEnqueueAvailabilityCacheRebuild` and discards the result.
 * Unchanged contract for its five existing callers: the OAuth connect callback, the schedule
 * editor, the availability-override routes, booking-time meeting-availability, and the
 * conflict-check toggle.
 */
export async function enqueueAvailabilityCacheRebuild(
  expertProfileId: string,
  log: FastifyBaseLogger
): Promise<void> {
  await tryEnqueueAvailabilityCacheRebuild(expertProfileId, log);
}

// ── Worker: Rebuild availability cache ───────────────────────────

/**
 * Processes availability cache rebuild jobs.
 *
 * Delegates the heavy lifting to `resolveAndCacheAvailability` (load tz +
 * rules + confirmed consultations, run the pure resolver, upsert the cache).
 * The worker stays thin: invoke, emit analytics, log.
 *
 * BAL-243: this passes no `busyBlocks`, so the service reads vendor free/busy
 * from the SHARED port (`services/availability/vendor-busy.ts`), which answers
 * `[]` until BAL-194/195 wires Cronofy.
 *
 * ⚠ BAL-194/195 MUST WIRE CRONOFY IN THAT PORT, **NOT** BY PASSING `busyBlocks`
 * FROM HERE (BAL-129). The `busyBlocks` option is a seed-only override; the
 * booking gate `isWindowAvailableForExpert` never sees it, so wiring a vendor
 * through this call site would leave bookings double-booking over an expert's
 * real external commitments with no type, test or helper failing.
 */
export function startAvailabilityCacheWorker(): Worker<AvailabilityCacheJobData> {
  const worker = new Worker<AvailabilityCacheJobData>(
    AVAILABILITY_CACHE_QUEUE,
    async (job: Job<AvailabilityCacheJobData>) => {
      const { expertProfileId } = job.data;

      const result = await resolveAndCacheAvailability(expertProfileId);

      // ⚠⚠ round-2 fix #11 — a SKIPPED rebuild (expert settings missing, or the vendor busy
      // read was untrustworthy — `resolveAndCacheAvailability` leaves last-known-good in
      // place either way) used to be reported IDENTICALLY to a completed one: same job.log
      // line, same `AVAILABILITY_CACHE_REBUILT` analytics fire. Branch on `result.status`, not
      // on `earliestAvailableAt` being `null` — that is also the legitimate answer for an
      // expert who genuinely has no open slot.
      if (result.status === 'skipped') {
        job.log(
          `Availability cache rebuild SKIPPED for expert ${expertProfileId} ` +
            `(${result.skipReason ?? 'unknown reason'}) — last-known-good cache left in place`
        );
        return;
      }

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
 * Checks for calendar connections whose credential hasn't been PROVEN in the last 15
 * minutes and enqueues rebuild jobs for each.
 *
 * ⚠⚠ BAL-396 FIX ROUND — THIS IS NOW THE PLATFORM'S ONLY TIME-BASED AVAILABILITY-REBUILD
 * TRIGGER. It used to key off `last_synced_at`, stamped only by the Cronofy-era webhook
 * route BAL-396 deletes — so with no writer left, this cron was a PERMANENT no-op (every
 * tick found zero stale connections and reported nothing wrong). `findStaleConnections` now
 * keys off `credential_checked_at` (stamped by the health probe and by connect/reconnect —
 * see `calendarRepository.findStaleConnections`'s docblock), restoring a real periodic
 * rebuild until BAL-468 ships the Apiroc webhook.
 */
export function startStalenessCheckWorker(): Worker {
  const worker = new Worker(
    STALENESS_CHECK_QUEUE,
    async (job: Job) => {
      const staleThreshold = new Date(Date.now() - STALENESS_CHECK_THRESHOLD_MS);
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
