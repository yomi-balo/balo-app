/**
 * BAL-649 (decision 3) — `call-now-ring-expiry`: the TIMELY trigger that ends a ring nobody
 * answered. One delayed job per ring, fired just after the ring's `expires_at`.
 *
 * ⚠⚠ THE JOB IS NOT THE RECORD. Postgres is: the ring row carries `expires_at` and a status
 * changed only by compare-and-set. This job's handler is `endRing(unanswered)`, an idempotent
 * CAS that no-ops unless the ring is still `ringing` AND already expired — so a connect, decline
 * or stop that won the race simply makes it a no-op, and "cancelling" the job is never needed.
 * Redis loss costs only timeliness: the per-minute lifecycle sweep ends any overdue ring.
 *
 * ⚠ `delay = (expiresAt − now) + 250 ms`. The margin keeps the job from firing a hair BEFORE the
 * CAS's `expires_at <= now` term could be true, which would burn an attempt on a miss.
 */
import { Worker, type Job } from 'bullmq';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { buildJobId, getQueue } from '../lib/queue.js';
import { endRing } from '../services/call-now/end-ring.js';

const log = createLogger('call-now-ring-expiry');

export const CALL_NOW_RING_EXPIRY_QUEUE = 'call-now-ring-expiry';

/** Added to the ring's remaining time so the job lands after `expires_at`, not on it. */
export const CALL_NOW_RING_EXPIRY_MARGIN_MS = 250;

const ATTEMPTS = 3;
const BACKOFF_DELAY_MS = 1000;

export interface CallNowRingExpiryJobData {
  ringId: string;
}

/** Schedule the expiry of one ring. Throws on an enqueue failure; the caller logs and carries on. */
export async function enqueueCallNowRingExpiry(
  ringId: string,
  expiresAt: Date,
  now: Date
): Promise<void> {
  await getQueue(CALL_NOW_RING_EXPIRY_QUEUE).add(
    'expire',
    { ringId } satisfies CallNowRingExpiryJobData,
    {
      jobId: buildJobId('call-now-ring-expiry', ringId),
      delay: Math.max(0, expiresAt.getTime() - now.getTime()) + CALL_NOW_RING_EXPIRY_MARGIN_MS,
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
      removeOnComplete: true,
      // The per-minute lifecycle sweep ends any ring past `expires_at`, so a failed job retained
      // in Redis would serve nothing.
      removeOnFail: true,
    }
  );
}

/** Thrown when the job fired before the ring's `expires_at`, so BullMQ's backoff retries it. */
export class RingNotYetDueError extends Error {
  constructor(public readonly ringId: string) {
    super(`Call now ring ${ringId} is still ringing and not yet due — retrying`);
    this.name = 'RingNotYetDueError';
  }
}

/**
 * A ring that already connected or ended is a no-op success. A ring STILL `ringing` after the CAS
 * missed was not yet due (the job fired early: clock skew, a short delay) — that throws, so the
 * backoff retries it promptly instead of leaving the end to the sweep up to a minute late.
 */
export async function handleCallNowRingExpiry(job: Job<CallNowRingExpiryJobData>): Promise<void> {
  const { ringId } = job.data;
  const outcome = await endRing({ ringId, to: 'unanswered', actorUserId: null, now: new Date() });
  if (outcome.ended) {
    return;
  }
  if (outcome.status === 'ringing') {
    throw new RingNotYetDueError(ringId);
  }
  log.info(
    { ringId, status: outcome.status },
    'call-now-ring-expiry: ring already settled — no-op'
  );
}

export function startCallNowRingExpiryWorker(): Worker<CallNowRingExpiryJobData> {
  const worker = new Worker<CallNowRingExpiryJobData>(
    CALL_NOW_RING_EXPIRY_QUEUE,
    async (job) => handleCallNowRingExpiry(job),
    { connection: createRedisConnection(), concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    if (!job) {
      return;
    }
    const attempts = job.opts.attempts ?? ATTEMPTS;
    if (job.attemptsMade < attempts) {
      return;
    }
    log.error(
      {
        ringId: job.data.ringId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'call-now-ring-expiry: exhausted retries — the lifecycle sweep ends the overdue ring'
    );
  });

  return worker;
}
