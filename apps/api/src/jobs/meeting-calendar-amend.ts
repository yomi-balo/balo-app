import { DelayedError, Worker, type Job } from 'bullmq';
import { calendarRepository, meetingCalendarEventsRepository, meetingsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { ApirocError } from '../lib/apiroc/errors.js';
import { classifyRetry } from '../lib/apiroc/retry.js';
import { updateConsultationEvent } from '../services/consultation-events/index.js';

const log = createLogger('meeting-calendar-amend-worker');

export const MEETING_CALENDAR_AMEND_QUEUE = 'meeting-calendar-amend';

export interface MeetingCalendarAmendJobData {
  meetingId: string;
  expertProfileId: string;
  /**
   * How many times this job has been DEFERRED for a vendor rate limit. Not the same as
   * `job.attemptsMade`: `moveToDelayed` + `DelayedError` deliberately does NOT consume an
   * attempt, so `attempts: 5` does not bound this path at all. Without its own counter a
   * vendor that keeps answering `rate_limited` would be retried forever, bounded only by each
   * `Retry-After`. Incremented via `job.updateData` before each deferral.
   */
  rateLimitDeferrals?: number;
}

/**
 * The ceiling on rate-limit deferrals. Chosen to be generous — a real rate limit clears well
 * inside this — while still terminating: past it the job falls through to the queue's ordinary
 * `attempts: 5` + exponential backoff and can finally FAIL, landing in the failed set where it
 * is visible, rather than deferring silently and indefinitely.
 */
const MAX_RATE_LIMIT_DEFERRALS = 10;

/**
 * BAL-409 (§4) — THE RETRYING, CONVERGING CALENDAR AMEND. A reschedule of a `scheduled` meeting
 * must move the expert's external calendar event too, but a vendor call CANNOT run inside the
 * reschedule transaction (`provision-meeting.ts`'s forced-ordering precedent: "COMMITTED — the
 * expert's calendar is already blocked" *then* the vendor calls). This job is that outbound
 * projection, and it is idempotent-on-retry by construction rather than best-effort: an inline
 * best-effort amend (the `projectBookingToExpertCalendar` shape) would leave the expert's
 * calendar on the OLD time on any transient vendor error with only a log line — precisely the
 * failure mode the ticket names to design against.
 *
 * ⚠⚠ THE PAYLOAD DELIBERATELY CARRIES NO WINDOW. Every handler run RE-READS the meeting row and
 * amends to WHATEVER IS THERE NOW — never the window in the job's own payload. That is what
 * makes out-of-order execution harmless: whichever job runs last writes current truth, and
 * EVERY job writes current truth. Combined with the per-move `jobId` below, at least one job
 * always runs after the final commit.
 *
 * ⚠ `jobId` IS THE IDEMPOTENCY KEY, AND IT IS THE `meeting.rescheduled` AUDIT ROW ID — NOT THE
 * TARGET WINDOW. A window-derived key (`meetingId:start-end`) looks right and is subtly wrong:
 * it is unique per DESTINATION, not per WRITE, so a move BACK to a previously-used window
 * regenerates a key that has already been used. A→B→C→B produces the same jobId as A→B, and
 * BullMQ silently no-ops an `add` whose jobId still exists in the RETAINED completed set
 * (`removeOnComplete: { count: 1000 }` below). The third move's amend would simply vanish: Balo
 * would say B while the expert's real calendar stayed on C, with nothing logged and nobody told —
 * precisely the silent divergence this whole job exists to prevent.
 *
 * `audit_events` is append-only, so its row id is unique per SUCCESSFUL MOVE. Retries of the same
 * move still collapse to one amend (the point of a jobId); genuinely distinct moves never do.
 */
export function enqueueMeetingCalendarAmend(
  meetingId: string,
  expertProfileId: string,
  rescheduleAuditId: string
): Promise<void> {
  const queue = getQueue(MEETING_CALENDAR_AMEND_QUEUE);
  const jobId = `meeting-calendar-amend:${rescheduleAuditId}`;
  return queue
    .add('amend', { meetingId, expertProfileId } satisfies MeetingCalendarAmendJobData, {
      jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    })
    .then(() => undefined);
}

/**
 * The convergence handler. Every branch below is a NO-OP-SAFE CONVERGENCE CHECK, not a
 * failure — "there was nothing to amend" is the normal shape for most meetings (no connected
 * calendar) and must never be logged or treated as an error.
 *
 * ⚠ THE WINDOW COMES FROM THE FRESHLY-READ `meeting` ROW, NOT THE JOB PAYLOAD — see the
 * enqueue docblock above.
 * ⚠ USES THE STORED `calendar_id`, NEVER THE EXPERT'S CURRENT `target_calendar_id` — the
 * expert may have changed their target calendar since the event was originally written.
 * ⚠ THERE IS DELIBERATELY NO "get connection by id" READ in `calendarRepository` — every
 * sanctioned read is keyed by (expert, provider) or by End User Account. So the End User
 * Account is resolved by listing the expert's connections and matching the STORED
 * `connectionId`.
 */
export async function processMeetingCalendarAmend(
  job: Job<MeetingCalendarAmendJobData>,
  token?: string
): Promise<void> {
  const { meetingId, expertProfileId } = job.data;

  // 1. Missing or soft-deleted ⇒ converged, nothing to amend.
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    job.log(`Meeting ${meetingId} not found (or soft-deleted) — converged, nothing to amend`);
    return;
  }

  // 2. Cancelled ⇒ the vendor calendar DELETE is BAL-476's, not this job's.
  //    ⚠ CORRECTED OWNER (orchestrator D2). This used to name BAL-410, which was true when it
  //    was written and is now false: BAL-410 shipped the CANCEL PRODUCER (the state flip, the
  //    `meeting.cancelled` audit row, the hold release, the Daily room delete and the
  //    `booking.cancelled` event) and deliberately emits NO calendar event and NO ICS. BAL-476
  //    owns the Apiroc `deleteConsultationEvent` call and the `METHOD:CANCEL` fan-out, and it
  //    names itself that function's first consumer.
  if (meeting.status === 'cancelled') {
    job.log(
      `Meeting ${meetingId} is cancelled — the vendor calendar delete belongs to BAL-476, not this job`
    );
    return;
  }

  // 3. No live EXPERT-PARTY PROVIDER event ⇒ nothing at a vendor to move. A normal case, not
  //    a failure: the expert has no connected calendar, the booking-time projection was
  //    skipped, or — since BAL-433 — this meeting recorded an `ics` FALLBACK row instead
  //    (ADR-1044 Ruling 1), which names no vendor event at all.
  //
  //    ⚠ RE-SENDING AN UPDATED ICS ON RESCHEDULE IS **NOT THIS JOB'S**, exactly as the vendor
  //    delete at step 2 is BAL-476's. Building and delivering the ICS is BAL-475; `METHOD:CANCEL` and
  //    the re-send fan-out are BAL-476. The accepted residual, stated rather than hidden: a
  //    rescheduled ICS-fallback expert currently holds a STALE calendar entry.
  //
  //    ⚠ THE READ IS NARROWED TO `party='expert' AND delivery_mode='provider_event'` — a
  //    whole-meeting read would hand back a client-party or ICS row and this job would try to
  //    address a vendor event that does not exist.
  const row = await meetingCalendarEventsRepository.findLiveExpertProviderEvent(meetingId);
  if (row === undefined) {
    job.log(
      `Meeting ${meetingId} has no live expert-party PROVIDER event — converged, nothing to amend`
    );
    return;
  }

  // 4. Resolve the End User Account off the STORED connectionId.
  const connections = await calendarRepository.listConnectionsByExpertProfileId(expertProfileId);
  const connection = connections.find((c) => c.id === row.connectionId);
  if (connection === undefined) {
    log.warn(
      { meetingId, expertProfileId, connectionId: row.connectionId },
      'Meeting calendar amend — the stored connection no longer exists; skipping'
    );
    return;
  }

  // 5. The amend itself — the window comes from the FRESH meeting row.
  try {
    await updateConsultationEvent({
      meetingId,
      endUserAccountId: connection.endUserAccountId,
      calendarId: row.calendarId,
      vendorEventId: row.vendorEventId,
      startAt: meeting.scheduledStart,
      endAt: meeting.scheduledEnd,
    });
    job.log(`Meeting ${meetingId} calendar event amended to the current window`);
  } catch (error) {
    await handleAmendError(job, error, { meetingId, expertProfileId }, token);
  }
}

/**
 * N7 — THE RETRY/NO-RETRY SPLIT IS `classifyRetry`'s (`lib/apiroc/retry.ts`), NOT A SECOND,
 * DRIFTING `switch` ON `ApirocError.kind` RE-IMPLEMENTED HERE. `classifyRetry` is already the
 * single source of truth `vendor-busy.ts`'s `isImmediatelyRetryable` consults; two independent
 * classifications of the same vendor error kinds WILL drift the day one of them adds/reclassifies
 * a kind and the other is not touched in the same change.
 *
 * `classifyRetry`'s verdict decides ONLY retry-or-not (and, for `rate_limited`, the delay);
 * the BUSINESS REACTION to each terminal (non-retry) kind is still this job's own to decide:
 *   `not_found` (the expert deleted the event by hand) ⇒ soft-delete Balo's row, warn, converge.
 *     The row's assertion ("Balo owns a live vendor event with this id") is FALSE after a 404;
 *     soft-deleting is what lets a future re-create INSERT (the unique is partial on
 *     `deleted_at IS NULL`). Restoring the event is Slice B's job, not this one's.
 *   `unauthorized` / `forbidden` ⇒ error-log and RETURN (do not burn retries) — the reconnect
 *     notification is the health probe's job (BAL-396 §9), not this one's.
 *   any other non-retryable (`validation`, `unknown`) ⇒ error-log and RETURN.
 *
 * ⚠ `retry: true` WITH `afterMs` SET (`rate_limited`) IS HONOURED, NOT IGNORED. BullMQ's queue
 * -level `backoff: { type: 'exponential', delay: 10_000 }` cannot see the vendor's own
 * `Retry-After`, so a rate-limited amend previously retried on the SAME exponential schedule as
 * a generic 5xx — spending an attempt against a vendor rate limit the apiroc skill records as
 * UNMEASURED, exactly the amplification risk `classifyRetry`'s own docblock warns about.
 * `job.moveToDelayed` + `DelayedError` asks BullMQ to wait the VENDOR's own requested interval
 * before the next attempt, instead.
 *
 * ⚠⚠ THE ACCEPTED RESIDUAL, WRITTEN DOWN SO A REVIEWER DOES NOT READ THE SILENCE AS AN
 * OVERSIGHT: if the amend ultimately fails after 5 attempts, NOTHING is surfaced to either
 * party in Slice A. Balo's own record (the case surface, the join route, the availability
 * cache, both notification emails) is already correct; only the expert's EXTERNAL calendar
 * entry lags. Detecting and repairing that lag is Slice B (expert-side drift + reconciliation),
 * which is blocked on an ADR-1021 amendment. The failed job stays in the BullMQ failed set
 * (`removeOnFail: { count: 5000 }`) and every attempt logs at `error` with the vendor
 * `x-request-id` — the only thing vendor support can act on.
 */
async function handleAmendError(
  job: Job<MeetingCalendarAmendJobData>,
  error: unknown,
  context: { meetingId: string; expertProfileId: string },
  token: string | undefined
): Promise<void> {
  if (!(error instanceof ApirocError)) {
    log.error(
      {
        ...context,
        attempt: job.attemptsMade,
        error: error instanceof Error ? error.message : String(error),
      },
      'Meeting calendar amend failed with an unrecognized error'
    );
    throw error;
  }

  const decision = classifyRetry(error);

  if (decision.retry) {
    log.warn(
      {
        ...context,
        attempt: job.attemptsMade,
        apirocRequestId: error.requestId,
        kind: error.kind,
        afterMs: decision.afterMs,
      },
      'Meeting calendar amend attempt failed — retrying'
    );
    // `afterMs` is set ONLY for `rate_limited` (see `classifyRetry`'s table) — honour the
    // vendor's own requested interval via a delayed retry rather than the queue's generic
    // exponential backoff. `token` is required by `moveToDelayed`; if BullMQ ever calls this
    // processor without one, fall back to the generic backoff rather than throwing a second,
    // more confusing error.
    const deferrals = job.data.rateLimitDeferrals ?? 0;
    if (decision.afterMs !== undefined && token !== undefined) {
      // ⚠ BOUNDED. `moveToDelayed` does not consume an attempt, so `attempts: 5` cannot stop
      // this loop — only this counter can. Past the ceiling, fall through to `throw error`
      // so the job takes an ordinary attempt and can eventually fail visibly.
      if (deferrals < MAX_RATE_LIMIT_DEFERRALS) {
        await job.updateData({ ...job.data, rateLimitDeferrals: deferrals + 1 });
        await job.moveToDelayed(Date.now() + decision.afterMs, token);
        throw new DelayedError();
      }
      log.error(
        { ...context, deferrals, apirocRequestId: error.requestId },
        'Meeting calendar amend rate-limited past the deferral ceiling — falling back to ordinary attempts'
      );
    }
    throw error;
  }

  switch (error.kind) {
    case 'not_found':
      // ⚠ PARTY-SCOPED (BAL-433). A vendor 404 happened on the EXPERT's calendar; soft-deleting
      // the whole meeting's rows would take a client-party row down as collateral.
      await meetingCalendarEventsRepository.softDeleteByMeetingAndParty(
        context.meetingId,
        'expert'
      );
      log.warn(context, 'Vendor event missing on amend — Balo expert-party row soft-deleted');
      return;

    case 'unauthorized':
    case 'forbidden':
      log.error(
        { ...context, apirocRequestId: error.requestId, kind: error.kind },
        'Meeting calendar amend failed — expert credential problem; reconnect is the health probe’s job'
      );
      return;

    default:
      log.error(
        {
          ...context,
          apirocRequestId: error.requestId,
          kind: error.kind,
        },
        'Expert calendar amend failed — calendar left on the old time'
      );
      return;
  }
}

export function startMeetingCalendarAmendWorker(): Worker<MeetingCalendarAmendJobData> {
  const worker = new Worker<MeetingCalendarAmendJobData>(
    MEETING_CALENDAR_AMEND_QUEUE,
    processMeetingCalendarAmend,
    {
      connection: createRedisConnection(),
      concurrency: 2,
    }
  );

  worker.on('failed', (job, err) => {
    log.error(
      {
        meetingId: job?.data.meetingId,
        attemptsMade: job?.attemptsMade,
        error: err.message,
      },
      'Expert calendar amend failed — calendar left on the old time'
    );
  });

  return worker;
}
