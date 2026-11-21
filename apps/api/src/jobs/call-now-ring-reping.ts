/**
 * `call-now-ring-reping`: re-sends the callee's bell ping for as long as a Call now ring is live.
 *
 * The callee's open tabs learn of a ring from a content-free `notification.created` ping
 * (`in-app-push.ts`), published once, right after the `call.ringing` bell row is written. The
 * ping is ephemeral, so a tab that misses it hears nothing more until its safety-net poll — and
 * a ring in the app lasts only 45 s. Re-sending the ping — twice early, at
 * {@link CALL_NOW_RING_REPING_EARLY_DELAYS_MS}, then every {@link CALL_NOW_RING_REPING_INTERVAL_MS}
 * — means one lost ping delays the ring toast by seconds instead of costing the call.
 *
 * ⚠ ONE DELAYED JOB PER TICK, ALL SCHEDULED WHEN THE RING STARTS, each with its own id. Every job
 * re-reads the ring and publishes only while it is still `ringing` and before `expires_at`, so a
 * ring that is answered, declined or stopped turns the remaining jobs into no-ops and nothing is
 * ever cancelled. A ping only makes the tab refetch its bell feed; the feed, not the ping, says
 * whether a call is ringing.
 *
 * ⚠ BEST EFFORT: `publishNotificationCreated` never rejects, and a failed job is not retried —
 * the next tick is the retry.
 */
import { Worker, type Job } from 'bullmq';
import { meetingRingsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { buildJobId, getQueue } from '../lib/queue.js';
import { publishNotificationCreated } from '../notifications/channels/in-app-push.js';

const log = createLogger('call-now-ring-reping');

export const CALL_NOW_RING_REPING_QUEUE = 'call-now-ring-reping';

/**
 * The first re-pings, from the ring's start. The bell row lands a few seconds after the ring
 * starts, so these reach a tab that missed the first ping while the ring is still young.
 */
export const CALL_NOW_RING_REPING_EARLY_DELAYS_MS: readonly number[] = [3_000, 6_000];

/** The gap between the steady re-pings, so a lost ping delays the ring toast by at most this. */
export const CALL_NOW_RING_REPING_INTERVAL_MS = 10_000;

export interface CallNowRingRepingJobData {
  ringId: string;
}

/**
 * The delays, from `now`, of every re-ping a ring gets, strictly before `expiresAt`: the early
 * re-pings, then one per interval. The ring's first ping is the in-app delivery's own.
 */
export function ringRepingDelaysMs(expiresAt: Date, now: Date): number[] {
  const remainingMs = expiresAt.getTime() - now.getTime();
  const delays = CALL_NOW_RING_REPING_EARLY_DELAYS_MS.filter((delayMs) => delayMs < remainingMs);
  for (
    let delayMs = CALL_NOW_RING_REPING_INTERVAL_MS;
    delayMs < remainingMs;
    delayMs += CALL_NOW_RING_REPING_INTERVAL_MS
  ) {
    delays.push(delayMs);
  }
  return delays;
}

/** Schedule every re-ping of one ring. Throws on an enqueue failure; the caller logs and carries on. */
export async function enqueueCallNowRingRepings(
  ringId: string,
  expiresAt: Date,
  now: Date
): Promise<void> {
  const delays = ringRepingDelaysMs(expiresAt, now);
  if (delays.length === 0) {
    return;
  }
  await getQueue(CALL_NOW_RING_REPING_QUEUE).addBulk(
    delays.map((delay, index) => ({
      name: 'reping',
      data: { ringId } satisfies CallNowRingRepingJobData,
      opts: {
        jobId: buildJobId('call-now-ring-reping', ringId, String(index + 1)),
        delay,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    }))
  );
}

/** Ping the callee again if the ring is still sounding; otherwise do nothing. */
export async function handleCallNowRingReping(
  job: Job<CallNowRingRepingJobData>,
  now: Date = new Date()
): Promise<void> {
  const { ringId } = job.data;
  const ring = await meetingRingsRepository.findById(ringId);
  if (ring?.status !== 'ringing' || ring.expiresAt.getTime() <= now.getTime()) {
    return;
  }
  await publishNotificationCreated(ring.calleeUserId);
  log.info(
    { ringId, ringAgeMs: now.getTime() - ring.createdAt.getTime() },
    'call-now-ring-reping: re-ping sent'
  );
}

export function startCallNowRingRepingWorker(): Worker<CallNowRingRepingJobData> {
  const worker = new Worker<CallNowRingRepingJobData>(
    CALL_NOW_RING_REPING_QUEUE,
    async (job) => handleCallNowRingReping(job),
    { connection: createRedisConnection(), concurrency: 10 }
  );

  worker.on('failed', (job, err) => {
    log.warn(
      {
        ringId: job?.data.ringId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'call-now-ring-reping: re-ping failed — the next tick pings again'
    );
  });

  return worker;
}
