import { Worker, type Job } from 'bullmq';
import {
  scheduledNotificationsRepository,
  type ScheduledNotification,
  type ScheduledNotificationPayload,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { notificationEvents } from '../notifications/publisher.js';
import {
  runRecheck,
  UnknownRecheckError,
  type RecheckResult,
} from '../notifications/scheduling/rechecks.js';
import type { EventPayloadMap, NotificationEvent } from '../notifications/events.js';

/**
 * BAL-420 (ADR-1047 Decision 3) — THE TICKER. Postgres is the clock; BullMQ only asks it
 * what time it is. One repeatable job, concurrency 1, doing ONE pass per tick:
 *
 *     listDue → claim → recheck → publish → mark
 *
 * ⚠ THERE IS NO `queue.add(…, { delay })` ANYWHERE IN THIS FEATURE, and that is the whole
 * design. A delayed BullMQ job makes the Redis delayed-set the only record of WHEN, so a
 * flush loses every pending promise with no trace that anything was owed; makes cancel a
 * `job.remove()` that silently does nothing on an active job and is impossible once the
 * jobId is evicted; and makes send-once rest on a completed-set entry that
 * `removeOnComplete: { count: 100 }` evicts within minutes at real volume. Here a 30-day
 * promise is a Postgres guarantee, cancellation is an exact `UPDATE`, and send-once is one
 * conditional `UPDATE … RETURNING`. BullMQ's jobId dedup is retained downstream as an
 * opportunistic second layer and relied on for NOTHING.
 *
 * THE GUARANTEE, stated honestly so nobody over-reads it: EXACTLY-ONCE under normal
 * operation; AT-LEAST-ONCE under a crash in the window between `publish` returning and the
 * row being marked `published`. Bounded by the claim TTL. Closing that last window needs a
 * transactional outbox — BAL-279's scope, not this one. (Same posture ADR-1040 takes for
 * settlement reconcile.)
 *
 * WORST-CASE LATENCY IS 60s AND IS ACCEPTED (ADR R1). BAL-134's absence alerts feed a HUMAN
 * ops loop measured in minutes; 60s is small against that and, crucially, BOUNDED. The
 * delayed-job alternative is unbounded: a Redis flush means nothing fires at all.
 *
 * Shape mirrors the seven existing domain sweeps (`credit-session-meter-sweep.ts` is the
 * closest template — same `* * * * *` cadence, five DB passes per tick including
 * money-critical settlement reconcile). NO reusable sweep abstraction is extracted here and
 * none of the existing sweeps is touched.
 */
export const SCHEDULED_NOTIFICATION_DISPATCH_QUEUE = 'scheduled-notification-dispatch';
export const SCHEDULED_NOTIFICATION_DISPATCH_CRON = '* * * * *'; // every minute

/**
 * A row `claimed` longer than this was stranded by a send that died; it is reclaimable.
 *
 * ⚠ APPLIED ON THE DATABASE CLOCK, NOT THIS PROCESS'S. `claim` stamps `claimed_at = now()`
 * and compares it against `now() - interval`, so replica clock skew cannot make a live claim
 * look stale (see `staleClaim` in the repository). What this value must still respect is
 * TICK DURATION: a tick that overruns the TTL can have its own rows reclaimed by the next
 * one. `BATCH_LIMIT` rows at a bounded per-row cost is what keeps a tick far inside 5
 * minutes — raising one without re-checking the other is how a double-send window reopens.
 */
const CLAIM_TTL_MINUTES = 5;
/** After this many claims a row is terminal `failed` — visible, never retried forever. */
const MAX_ATTEMPTS = 3;
/** Bounds a post-outage backlog per tick; oldest-first, so it drains at a fixed rate (R4). */
const BATCH_LIMIT = 200;

const logger = createLogger('scheduled-notification-dispatch');

/** What happened to one row this tick. `none` = not ours to send (and nothing was sent). */
type RowOutcome = 'published' | 'skipped' | 'failed' | 'none';

export interface ScheduledNotificationDispatchCounts {
  published: number;
  skipped: number;
  failed: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

/**
 * Hand the stored `(event, payload)` pair back to the ordinary publisher.
 *
 * ⚠ THE PAIR WAS TYPE-CHECKED AT SCHEDULE TIME, by `scheduleNotification`'s
 * `<E extends NotificationEvent>(event: E, payload: EventPayloadMap[E])` signature. A
 * database read returns `text` + `jsonb` and cannot re-prove that correspondence, so this is
 * the single, deliberately localised place where the static pair is re-established. Nothing
 * downstream is weakened by it: `processNotificationEvent` already reads the event as a
 * `string` and the payload as `Record<string, unknown>`, and an event with no rules is
 * logged and dropped rather than throwing.
 */
async function publishStoredEvent(
  event: string,
  payload: ScheduledNotificationPayload
): Promise<void> {
  await notificationEvents.publish(
    event as NotificationEvent,
    payload as unknown as EventPayloadMap[NotificationEvent]
  );
}

/**
 * Terminal-`failed` a row whose attempts are spent.
 *
 * `claim`'s own `attempts < maxAttempts` predicate makes such a row unclaimable, so without
 * this it would sit `claimed` forever, re-selected by every tick and never resolved. Only a
 * stale-`claimed` row can reach the ceiling — `attempts` is incremented BY the claim, which
 * also moves the row off `pending`.
 *
 * ⚠ `last_error` ONLY EVER CARRIES THIS SYNTHETIC EXHAUSTION MESSAGE, never the underlying
 * per-attempt error. That is deliberate: the TRANSIENT path writes nothing to the row at all
 * (it rethrows and leaves the row `claimed`, so a DB blip cannot consume the notification),
 * and adding a `recordAttemptError` write would put a non-terminal mutation on a path whose
 * whole value is that it touches nothing. The individual failures are in the structured logs
 * — Axiom, keyed by `id` and `key` — not on the row. The row answers "did this die, and
 * after how many tries"; the log answers "why".
 */
async function abandonExhausted(row: ScheduledNotification): Promise<RowOutcome> {
  const reason = `Dispatch abandoned after ${row.attempts} attempts`;
  await scheduledNotificationsRepository.markFailed(row.id, reason);
  logger.error(
    {
      id: row.id,
      key: row.dedupeKey,
      event: row.event,
      attempts: row.attempts,
      lastError: reason,
    },
    'Scheduled notification abandoned — attempts exhausted'
  );
  return 'failed';
}

/**
 * Claim → recheck → publish → mark, for ONE candidate row.
 *
 * ⚠ NOTHING IS SWALLOWED IN HERE. The claim in particular MUST FAIL LOUD: it is not
 * telemetry, it IS the send-once guarantee, and a swallowed error would turn "we lost the
 * race" into "we won it". Anything that throws propagates to the caller's per-row handler,
 * which logs at `error` and moves on, leaving the row `claimed` for the TTL reconcile.
 */
async function dispatchRow(candidate: ScheduledNotification): Promise<RowOutcome> {
  if (candidate.attempts >= MAX_ATTEMPTS) {
    return abandonExhausted(candidate);
  }

  // ⚠ THE SEND-ONCE GATE. `undefined` means one of: another worker (or another Railway
  // replica — each registers this same cron) won the race; the row was cancelled; it is
  // claimed and not yet stale; attempts are spent; it is soft-deleted. Every one of those
  // means "not yours to send", so we PUBLISH NOTHING and say nothing about which it was.
  const row = await scheduledNotificationsRepository.claim({
    id: candidate.id,
    claimTtlMinutes: CLAIM_TTL_MINUTES,
    maxAttempts: MAX_ATTEMPTS,
  });
  if (row === undefined) {
    return 'none';
  }

  let result: RecheckResult;
  try {
    result = await runRecheck(row);
  } catch (error) {
    if (error instanceof UnknownRecheckError) {
      // DEPLOY SKEW: a row scheduled by an older build whose guard was renamed or removed.
      // Failing closed on an unknown guard is the only safe reading — never a silent
      // publish, never a silent skip.
      await scheduledNotificationsRepository.markFailed(row.id, error.message);
      logger.error(
        { id: row.id, key: row.dedupeKey, event: row.event, recheck: error.recheck },
        'Scheduled notification recheck is not registered — failing closed'
      );
      return 'failed';
    }
    // Anything else is presumed TRANSIENT (a DB blip must not consume the notification):
    // rethrow, leaving the row `claimed` so the TTL reconcile retries it next window.
    throw error;
  }

  if (!result.publish) {
    // A NORMAL outcome, not a failure — `skip_reason`, never `last_error`, and `info`,
    // never `error`. This is the whole point of the guard: the reason went away.
    await scheduledNotificationsRepository.markSkipped(row.id, result.reason);
    logger.info(
      { id: row.id, key: row.dedupeKey, event: row.event, reason: result.reason },
      'Scheduled notification skipped by fire-time recheck'
    );
    return 'skipped';
  }

  // ⚠ THE PAYLOAD IS RE-VALIDATED BEFORE IT IS PUBLISHED, and `correlationId` is the one
  // field that MUST survive. `scheduleNotification` proves it statically (its
  // `EventPayloadMap[E]` requires it), but a RECHECK returns `Record<string, unknown>` and
  // Decision 6 actively encourages rebuilding the payload from the live state it just read —
  // so nothing upstream guarantees the rebuilt object still carries one.
  //
  // Dropping it is not a cosmetic defect. `publisher.publish` mints
  // `jobId = \`${event}--${payload.correlationId}\``, so every scheduled promise of that
  // event would collapse into the SINGLE BullMQ job `event--undefined` for as long as it sat
  // in the completed set: the second no-show alert is silently never delivered WHILE THE ROW
  // IS MARKED `published`. `notification_log.correlation_id` is `NOT NULL`, so the audit
  // insert would throw into `logNotification`'s swallowing catch and leave no trace either.
  // That is precisely the eviction-dependent dedup this ADR exists to stop depending on.
  //
  // So: fail CLOSED and LOUD, exactly as the unregistered-recheck path does. A promise that
  // cannot be published correctly is a terminal `failed` with a readable reason, never a
  // best-effort send.
  const correlationId = result.payload.correlationId;
  if (typeof correlationId !== 'string' || correlationId.length === 0) {
    const reason =
      `Recheck '${row.recheck ?? 'none'}' returned a payload with no usable correlationId ` +
      `— refusing to publish (it would collapse this event's BullMQ jobId)`;
    await scheduledNotificationsRepository.markFailed(row.id, reason);
    logger.error(
      { id: row.id, key: row.dedupeKey, event: row.event, recheck: row.recheck },
      'Scheduled notification payload has no correlationId — failing closed'
    );
    return 'failed';
  }

  // The payload the RECHECK returned — the stored one is only the default answer.
  await publishStoredEvent(row.event, result.payload);
  await scheduledNotificationsRepository.markPublished(row.id);
  return 'published';
}

/** The tick body (exported for unit testing without a Redis-backed Worker). */
export async function runScheduledNotificationDispatch(
  now: Date,
  log: (message: string) => void = () => {}
): Promise<ScheduledNotificationDispatchCounts> {
  const due = await scheduledNotificationsRepository.listDue({
    now,
    claimTtlMinutes: CLAIM_TTL_MINUTES,
    limit: BATCH_LIMIT,
  });

  if (due.length >= BATCH_LIMIT) {
    const [oldest] = due;
    logger.warn(
      { limit: BATCH_LIMIT, oldestScheduledFor: oldest?.scheduledFor.toISOString() },
      'Scheduled notification dispatch filled its batch — backlog draining'
    );
  }

  const counts: ScheduledNotificationDispatchCounts = { published: 0, skipped: 0, failed: 0 };

  // Each row isolated in its own try/catch — the house pattern; one bad row never aborts
  // the batch, and a row left `claimed` by a throw is picked up by the TTL reconcile.
  for (const candidate of due) {
    try {
      const outcome = await dispatchRow(candidate);
      if (outcome !== 'none') {
        counts[outcome] += 1;
      }
    } catch (error) {
      const message = errorMessage(error);
      log(`scheduled notification dispatch failed for ${candidate.id}: ${message}`);
      logger.error(
        {
          id: candidate.id,
          key: candidate.dedupeKey,
          event: candidate.event,
          attempts: candidate.attempts,
          error: message,
          stack: errorStack(error),
        },
        'Scheduled notification dispatch failed'
      );
    }
  }

  logger.info(counts, 'Scheduled notification dispatch complete');
  return counts;
}

/** Start the dispatch worker (concurrency 1 — one tick at a time). */
export function startScheduledNotificationDispatchWorker(): Worker {
  return new Worker(
    SCHEDULED_NOTIFICATION_DISPATCH_QUEUE,
    async (job: Job) => {
      const { published, skipped, failed } = await runScheduledNotificationDispatch(
        new Date(),
        (m) => job.log(m)
      );
      job.log(
        `scheduled notification dispatch: ${published} published, ${skipped} skipped, ${failed} failed`
      );
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable per-minute dispatch tick. */
export async function registerScheduledNotificationDispatchCron(): Promise<void> {
  const queue = getQueue(SCHEDULED_NOTIFICATION_DISPATCH_QUEUE);
  await queue.add(
    'dispatch',
    {},
    {
      repeat: { pattern: SCHEDULED_NOTIFICATION_DISPATCH_CRON },
      removeOnComplete: true,
    }
  );
}
