/**
 * BAL-581 — THE VENUE REPAIR. A meeting whose Daily room was never created (vendor
 * outage, 429, a missing `DAILY_API_KEY`, a failed `setVenue`) would otherwise be permanently
 * unjoinable — nothing ever calls `provisionMeeting` again for it. This module is what does.
 *
 * TWO QUEUES IN ONE MODULE (the `meeting-lifecycle-sweep.ts` → `recording-capture.ts` split,
 * BAL-480): the per-minute cron producer never waits behind the Daily rate limiter, and the
 * limiter governs Daily calls only.
 *
 * ```
 * repeatable cron  (* * * * *)              queue: meeting-venue-repair-sweep  (concurrency 1)
 *   runMeetingVenueRepairSweep(now)
 *     ├─ DAILY_API_KEY unset?  → one warn, return { skipped: 'daily_api_key_missing' }
 *     ├─ meetingsRepository.listUnprovisionedScheduled(...)
 *     ├─ per row: dueVenueRepair(...) → null | { checkpointBucket, final }
 *     └─ enqueueVenueProvision(...)  — two-pass, budget MAX_VENUE_REPAIRS_PER_TICK
 *                                        queue: meeting-venue-provision (concurrency 2, limiter)
 *   handleVenueProvision(job)
 *     guards → primary context → provisionMeeting(id, { ..., trigger: 'repair' })
 * ```
 *
 * The checkpoint SCHEDULE (when a meeting is due) lives in
 * `services/meetings/venue-repair-schedule.ts` — pure, no I/O, unit-tested on its own. This
 * module is the I/O shell around it: read candidates, ask the schedule, enqueue, and — in the
 * handler — re-read, re-check and provision.
 */
import { Worker, type Job } from 'bullmq';
import { meetingsRepository, meetingContextsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  isBookableContextType,
  isMeetingVenueReady,
  selectPrimaryMeetingContext,
} from '@balo/shared/meetings';
import type { FastifyBaseLogger } from 'fastify';
import { createRedisConnection } from '../lib/redis.js';
import { buildJobId, getQueue } from '../lib/queue.js';
import { resolveMeetingTimers } from '../config/meeting-timers.js';
import { isDailyApiKeyConfigured } from '../services/daily/client.js';
import { engagementTypeForContext } from '../services/meetings/authorize-meeting-booking.js';
import { provisionMeeting } from '../services/meetings/provision-meeting.js';
import {
  bucketOf,
  dueVenueRepair,
  venueRepairCandidateStartAfter,
  venueRepairCutoff,
} from '../services/meetings/venue-repair-schedule.js';

const logger = createLogger('meeting-venue-repair');

/**
 * A `FastifyBaseLogger`-shaped adapter over the scoped Pino logger, so this job can call
 * `provisionMeeting` (typed against Fastify's logger) without a Fastify request in hand — the
 * `calendar-health-probe.ts` precedent.
 */
const jobLogger = logger as unknown as FastifyBaseLogger;

export const MEETING_VENUE_REPAIR_SWEEP_QUEUE = 'meeting-venue-repair-sweep';
export const MEETING_VENUE_REPAIR_SWEEP_CRON = '* * * * *';
export const MEETING_VENUE_PROVISION_QUEUE = 'meeting-venue-provision';

/** Candidate read bound. ⚠ The sweep warns when it fills (no silent caps). */
export const VENUE_REPAIR_CANDIDATE_LIMIT = 500;

/** Per-tick enqueue budget. ⚠ The sweep warns when it fills (no silent caps). */
export const MAX_VENUE_REPAIRS_PER_TICK = 60;

/**
 * One provision is ≤ 4 Daily calls (POST, reconcile POST, GET, and a DELETE on a non-private
 * room); 2 jobs/s ≤ 8 calls/s = 40 % of the 20/s room tier, leaving headroom for booking-time
 * creates, token mints and presence reads.
 */
const DAILY_ROOM_PROVISION_LIMITER = { max: 2, duration: 1000 } as const;

/**
 * Retention that makes a checkpoint's jobId dedupe the NEXT tick's catch-up enqueue —
 * comfortably longer than the ≥ 1-tick gap the one-tick catch-up relies on.
 */
const CHECKPOINT_JOB_RETENTION = { age: 600 } as const; // seconds

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MeetingVenueRepairSweepResult {
  scanned: number;
  due: number;
  enqueued: number;
  deferred: number;
  skipped?: 'daily_api_key_missing';
}

export interface VenueProvisionJobData {
  meetingId: string;
  /** The checkpoint's minute bucket — the jobId token; also logged. */
  checkpointBucket: number;
  /** Final checkpoint before the cutoff — escalates a failure. */
  final: boolean;
}

/** One candidate row, resolved against the checkpoint schedule. */
interface DueCandidate {
  readonly meetingId: string;
  readonly checkpointBucket: number;
  readonly final: boolean;
}

export async function enqueueVenueProvision(data: VenueProvisionJobData): Promise<void> {
  await getQueue(MEETING_VENUE_PROVISION_QUEUE).add('provision', data, {
    jobId: buildJobId('meeting-venue-provision', data.meetingId, `c${data.checkpointBucket}`),
    attempts: 1,
    removeOnComplete: CHECKPOINT_JOB_RETENTION,
    removeOnFail: CHECKPOINT_JOB_RETENTION,
    // No `priority` — a single job name on its own queue, so FIFO already keeps soonest-first,
    // and `priority: 0` is a trap (memory `reference_bullmq_priority_zero_is_unprioritized`).
  });
}

/**
 * Best-effort enqueue — a BullMQ/Redis blip must not stop the sweep from evaluating the rest
 * of the tick's candidates. The NEXT checkpoint (or the one-tick catch-up) retries.
 */
async function enqueueVenueProvisionBestEffort(data: VenueProvisionJobData): Promise<void> {
  try {
    await enqueueVenueProvision(data);
  } catch (error) {
    logger.error(
      { meetingId: data.meetingId, error: errorMessage(error) },
      'Venue repair enqueue failed — the next checkpoint retries'
    );
  }
}

/**
 * The sweep body (exported for unit testing without a Redis-backed Worker).
 *
 * TWO PASSES over the due candidates so a catch-up re-add (a BullMQ dedupe no-op
 * that still spends budget) can never starve a FRESH checkpoint: pass 1 is every row whose
 * checkpoint is due THIS bucket, pass 2 is every row due at the CATCH-UP bucket, with
 * whatever budget pass 1 left over. `listUnprovisionedScheduled` already orders soonest-first,
 * and filtering preserves that order within each pass.
 */
export async function runMeetingVenueRepairSweep(
  now: Date
): Promise<MeetingVenueRepairSweepResult> {
  if (!isDailyApiKeyConfigured()) {
    logger.warn(
      'DAILY_API_KEY is not set — venue repair pass skipped; unprovisioned meetings stay roomless until it is set'
    );
    return { scanned: 0, due: 0, enqueued: 0, deferred: 0, skipped: 'daily_api_key_missing' };
  }

  const timers = resolveMeetingTimers();
  const rows = await meetingsRepository.listUnprovisionedScheduled({
    scheduledStartAfter: venueRepairCandidateStartAfter(now, timers),
    createdBefore: now,
    limit: VENUE_REPAIR_CANDIDATE_LIMIT,
  });
  if (rows.length === VENUE_REPAIR_CANDIDATE_LIMIT) {
    logger.warn(
      { limit: VENUE_REPAIR_CANDIDATE_LIMIT, latestScheduledStart: rows.at(-1)?.scheduledStart },
      'Venue repair candidate batch FILLED — later meetings were not evaluated this tick'
    );
  }

  let due = 0;
  const dueCandidates: DueCandidate[] = [];
  for (const row of rows) {
    const result = dueVenueRepair({
      now,
      createdAt: row.createdAt,
      scheduledStart: row.scheduledStart,
      timers,
    });
    if (result === null) continue;
    due += 1;
    dueCandidates.push({
      meetingId: row.meetingId,
      checkpointBucket: result.checkpointBucket,
      final: result.final,
    });
  }

  const nowBucket = bucketOf(now.getTime());
  const freshPass = dueCandidates.filter((c) => c.checkpointBucket === nowBucket);
  const catchUpPass = dueCandidates.filter((c) => c.checkpointBucket === nowBucket - 1);

  let enqueued = 0;
  let deferred = 0;
  for (const candidate of [...freshPass, ...catchUpPass]) {
    if (enqueued < MAX_VENUE_REPAIRS_PER_TICK) {
      enqueued += 1;
      await enqueueVenueProvisionBestEffort(candidate);
    } else {
      deferred += 1;
    }
  }

  if (deferred > 0) {
    logger.warn(
      { limit: MAX_VENUE_REPAIRS_PER_TICK, deferred },
      'Venue repair fan-out cap FILLED — deferred to later checkpoints'
    );
  }

  const result: MeetingVenueRepairSweepResult = { scanned: rows.length, due, enqueued, deferred };
  logger.info(result, 'Venue repair sweep complete');
  return result;
}

/**
 * The handler (exported for unit testing without a Redis-backed Worker).
 *
 * A GUARD SEQUENCE that re-reads and re-checks everything the producer already checked: the
 * producer's read is a batch snapshot that can be minutes stale by the time this job runs, and
 * nothing about the enqueue guarantees the meeting is still a live, unprovisioned, in-cutoff,
 * bookable-context candidate.
 */
export async function handleVenueProvision(job: Job<VenueProvisionJobData>): Promise<void> {
  const now = new Date();
  const { meetingId, final, checkpointBucket } = job.data;

  if (!isDailyApiKeyConfigured()) {
    logger.warn({ meetingId }, 'Venue repair skipped — DAILY_API_KEY is not set');
    return;
  }

  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    logger.info({ meetingId }, 'Venue repair skipped — meeting missing or deleted');
    return;
  }

  // `provisionMeeting` has no status guard of its own — this is what stops a lagging job from
  // stamping a room on a meeting whose teardown (cancel, or a terminal rule) already ran.
  if (meeting.status !== 'scheduled') {
    logger.info(
      { meetingId, status: meeting.status },
      'Venue repair skipped — meeting no longer scheduled'
    );
    return;
  }

  if (isMeetingVenueReady(meeting)) {
    logger.info({ meetingId }, 'Venue repair skipped — already provisioned');
    return;
  }

  const timers = resolveMeetingTimers();
  if (now >= venueRepairCutoff(meeting.scheduledStart, timers)) {
    logger.info({ meetingId }, 'Venue repair skipped — past the repair cutoff');
    return;
  }

  const primary = selectPrimaryMeetingContext(
    await meetingContextsRepository.listByMeeting(meetingId)
  );
  if (!primary.ok) {
    logger.warn(
      { meetingId, reason: primary.reason },
      'Venue repair skipped — no bookable primary context'
    );
    return;
  }
  const primaryContextType = primary.context.contextType;
  if (!isBookableContextType(primaryContextType)) {
    // Every meeting that reaches `scheduled` through a real path was booked through
    // `POST /meetings`; a seeded or admin meeting is not auto-provisioned.
    logger.warn(
      { meetingId, reason: primaryContextType },
      'Venue repair skipped — no bookable primary context'
    );
    return;
  }

  const engagementType = engagementTypeForContext(primaryContextType);
  const result = await provisionMeeting(
    meetingId,
    {
      contextType: primaryContextType,
      engagementType,
      distinctId: meetingId,
      trigger: 'repair',
      escalateFailure: final,
    },
    jobLogger
  );

  // A failure needs no extra log here — `provisionVenue` already logged at the right level
  // (warn on a non-final checkpoint, error + Sentry on the final one). Never throw on a
  // vendor failure — the checkpoint schedule IS the retry policy.
  if (result?.provisioned) {
    logger.info({ meetingId, checkpointBucket, replayed: result.replayed }, 'Venue repaired');
  }
}

/** The Daily-rate-limited provision worker (concurrency 2, rate limited). */
export function startMeetingVenueProvisionWorker(): Worker<VenueProvisionJobData> {
  const worker = new Worker<VenueProvisionJobData>(
    MEETING_VENUE_PROVISION_QUEUE,
    async (job) => {
      if (job.name !== 'provision') {
        // Defensive: no other job name is ever enqueued onto this queue.
        logger.error(
          { jobName: job.name },
          'meeting-venue-provision: unknown job name — acking with no effect'
        );
        return;
      }
      await handleVenueProvision(job);
    },
    {
      connection: createRedisConnection(),
      concurrency: 2,
      limiter: DAILY_ROOM_PROVISION_LIMITER,
    }
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    // An UNEXPECTED throw — a DB fault, not a vendor failure (those are caught and reported
    // inside `provisionVenue`).
    logger.error(
      { meetingId: job.data.meetingId, error: errorMessage(err) },
      'Venue repair job failed unexpectedly'
    );
  });

  return worker;
}

/** The producer worker (concurrency 1 — the cron never waits behind the Daily limiter). */
export function startMeetingVenueRepairSweepWorker(): Worker {
  return new Worker(
    MEETING_VENUE_REPAIR_SWEEP_QUEUE,
    async () => {
      await runMeetingVenueRepairSweep(new Date());
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable per-minute venue repair sweep. */
export async function registerMeetingVenueRepairSweepCron(): Promise<void> {
  const queue = getQueue(MEETING_VENUE_REPAIR_SWEEP_QUEUE);
  await queue.add(
    'sweep',
    {},
    {
      repeat: { pattern: MEETING_VENUE_REPAIR_SWEEP_CRON },
      removeOnComplete: true,
    }
  );
}
