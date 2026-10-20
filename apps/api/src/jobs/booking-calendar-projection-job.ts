import { Worker, type Job } from 'bullmq';
import {
  auditEventsRepository,
  meetingCalendarEventsRepository,
  meetingsRepository,
  type Meeting,
} from '@balo/db';
import { MEETING_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import { createLogger } from '@balo/shared/logging';
import type { MeetingBookingContextType } from '@balo/shared/meetings';
import type { FastifyBaseLogger } from 'fastify';
import { createRedisConnection } from '../lib/redis.js';
import { buildJobId, getQueue } from '../lib/queue.js';
import { publishBookingCalendarInvites } from '../services/calendar-invites/publish-calendar-invites.js';
import {
  logCalendarProjectionOutcome,
  projectBookingCalendarEvent,
  recordClientCalendarEntry,
  type BookingProjectionSubject,
  type ExpertCalendarDelivery,
} from '../services/consultation-events/booking-calendar-projection.js';
import { reportCalendarAmendEnqueueFailure } from '../services/meetings/meeting-availability.js';
import { withdrawMeetingCalendarProjection } from '../services/meetings/withdraw-meeting-calendar.js';
import { enqueueMeetingCalendarAmend } from './meeting-calendar-amend.js';

const logger = createLogger('booking-calendar-projection-worker');

/**
 * A `FastifyBaseLogger`-shaped adapter over the scoped Pino logger, so this job can call the
 * projection and invite services (typed against Fastify's logger) without a Fastify request in
 * hand — the `meeting-venue-repair.ts` precedent.
 */
const jobLogger = logger as unknown as FastifyBaseLogger;

export const BOOKING_CALENDAR_PROJECTION_QUEUE = 'booking-calendar-projection';

export interface BookingCalendarProjectionJobData {
  meetingId: string;
  expertProfileId: string | null;
  contextType: MeetingBookingContextType;
  contextId: string;
  userId: string;
}

/**
 * One projection per meeting, ever — a booking is created once, and a replay never enqueues.
 * The id is also the key the job hands the amend queue when the window moved while it ran.
 */
export function bookingCalendarProjectionJobId(meetingId: string): string {
  return buildJobId(BOOKING_CALENDAR_PROJECTION_QUEUE, meetingId);
}

/**
 * ⚠ `attempts: 1` AND NO `backoff`, and `maxStalledCount: 0` on the worker below. Apiroc's
 * `events.create` is not idempotent (apiroc skill §M1: a caller-supplied id is not a portable
 * idempotency lever), so a re-run after a crash or a stall can strand a first vendor event and
 * double-invite. A failed or stalled projection is therefore kept in the failed set, visible,
 * and never re-run.
 */
export async function enqueueBookingCalendarProjection(
  data: BookingCalendarProjectionJobData
): Promise<void> {
  await getQueue(BOOKING_CALENDAR_PROJECTION_QUEUE).add('project-booking-calendar', data, {
    jobId: buildJobId(BOOKING_CALENDAR_PROJECTION_QUEUE, data.meetingId),
    attempts: 1,
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `error` + `stack` pair every caught-error log line carries. */
function errorFields(error: unknown): { error: string; stack: string | undefined } {
  return { error: errorMessage(error), stack: error instanceof Error ? error.stack : undefined };
}

/** Reports `skipped` for both parties: the meeting was cancelled or removed before the job ran. */
function reportSkippedProjection(data: BookingCalendarProjectionJobData): void {
  const { meetingId, contextType, contextId, userId } = data;
  for (const party of ['expert', 'client'] as const) {
    logCalendarProjectionOutcome(
      { meetingId, party, contextType, contextId, deliveryMode: 'skipped' },
      jobLogger
    );
    trackServer(MEETING_SERVER_EVENTS.MEETING_CALENDAR_PROJECTED, {
      meeting_id: meetingId,
      context_type: contextType,
      party,
      delivery: 'skipped',
      distinct_id: userId,
    });
  }
}

/**
 * The projection call, with the call site's own belt on top of its braces.
 *
 * ⚠ `projectBookingCalendarEvent`'s CONTRACT IS ALREADY "NEVER THROWS" (ADR-1044 D2c) and its
 * two callees each own a `try`/`catch`. This wrapper is DEFENCE IN DEPTH: a violation of that
 * contract must not abort the job before the client row and the invites. It reports `'failed'`
 * — the same value the projection itself returns for a swallowed error — so the analytics emit
 * stays unconditional and one outcome vocabulary covers both paths.
 */
async function projectBookingCalendarEventSafely(
  subject: BookingProjectionSubject,
  data: BookingCalendarProjectionJobData
): Promise<ExpertCalendarDelivery> {
  try {
    return await projectBookingCalendarEvent(subject, data.contextType, data.contextId, jobLogger);
  } catch (error) {
    jobLogger.error(
      {
        meetingId: data.meetingId,
        // ⚠ `party` + `deliveryMode` ARE THE CORRELATION KEYS, NOT DECORATION. This path returns
        // BEFORE `projectBookingCalendarEvent` can emit its outcome line, so this is the ONLY
        // Axiom record of a contract-violation projection; an Axiom query filtered on
        // `deliveryMode` would otherwise undercount failures while the PostHog emit carries both.
        party: 'expert',
        deliveryMode: 'failed' satisfies ExpertCalendarDelivery,
        contextType: data.contextType,
        contextId: data.contextId,
        error: errorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'The expert calendar projection threw despite its never-throws contract — invites still publish'
    );
    return 'failed';
  }
}

/**
 * `publishBookingCalendarInvites`'s own contract is ALREADY "never throws" (each of its three
 * publishers try/catches its per-recipient enqueue). This wrapper is DEFENCE IN DEPTH,
 * matching {@link projectBookingCalendarEventSafely}: a violation of that contract is logged and
 * swallowed, so it fails nothing beyond the invites it was about to enqueue.
 */
async function publishBookingCalendarInvitesSafely(
  data: BookingCalendarProjectionJobData
): Promise<void> {
  try {
    await publishBookingCalendarInvites(
      {
        meetingId: data.meetingId,
        contextType: data.contextType,
        expertProfileId: data.expertProfileId,
      },
      jobLogger
    );
  } catch (error) {
    jobLogger.error(
      {
        meetingId: data.meetingId,
        contextType: data.contextType,
        error: errorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Calendar invite publish threw despite its never-throws contract — the invites were skipped'
    );
  }
}

/**
 * Expert projection, then client row, with an analytics emit after each. Order is
 * load-bearing: `publishBookingCalendarInvites` READS the LIVE `meeting_calendar_events` rows
 * these two steps write, so it must run after both.
 */
async function projectBothParties(
  subject: BookingProjectionSubject,
  data: BookingCalendarProjectionJobData
): Promise<void> {
  const { meetingId, contextType, contextId, userId } = data;

  const expertDelivery = await projectBookingCalendarEventSafely(subject, data);
  trackServer(MEETING_SERVER_EVENTS.MEETING_CALENDAR_PROJECTED, {
    meeting_id: meetingId,
    context_type: contextType,
    party: 'expert',
    delivery: expertDelivery,
    distinct_id: userId,
  });

  const clientDelivery = await recordClientCalendarEntry(
    meetingId,
    contextType,
    contextId,
    jobLogger
  );
  trackServer(MEETING_SERVER_EVENTS.MEETING_CALENDAR_PROJECTED, {
    meeting_id: meetingId,
    context_type: contextType,
    party: 'client',
    delivery: clientDelivery,
    distinct_id: userId,
  });
}

/**
 * P3's read. A throw is logged and reported as `'unreadable'` rather than propagated. The
 * caller then still looks for a cancellation audit row; with none found, the invites go out,
 * because the delivery path's meeting gate refuses a later REQUEST for a `cancelled` meeting.
 */
async function rereadMeeting(
  meetingId: string
): Promise<{ meeting: Meeting | undefined } | 'unreadable'> {
  try {
    return { meeting: await meetingsRepository.findById(meetingId) };
  } catch (error) {
    jobLogger.error(
      { meetingId, ...errorFields(error) },
      'Could not re-read the meeting after projecting it — looking for a cancellation'
    );
    return 'unreadable';
  }
}

/**
 * Withdraws the projection against the meeting's cancellation audit row, and says whether such
 * a row existed. The cancel route's own withdrawal may have run BEFORE the projection wrote its
 * rows, so withdrawing here with the cancel's own audit id (the same correlation key, so one set
 * of CANCELs) closes that gap. Never throws: a failed lookup or withdrawal is logged, and a
 * failed lookup reads as "no row".
 */
async function withdrawIfCancelled(data: BookingCalendarProjectionJobData): Promise<boolean> {
  const { meetingId, expertProfileId } = data;
  try {
    const audit = await auditEventsRepository.findLatestByEntityAndAction({
      entityType: 'meeting',
      entityId: meetingId,
      action: 'meeting.cancelled',
    });
    if (audit === undefined) return false;
    await withdrawMeetingCalendarProjection(
      { meetingId, cancelAuditId: audit.id, expertProfileId },
      jobLogger
    );
    return true;
  } catch (error) {
    jobLogger.error(
      { meetingId, ...errorFields(error) },
      'Calendar withdrawal after a mid-projection cancellation failed — the projection may be left in place'
    );
    return false;
  }
}

/**
 * The meeting was cancelled (or soft-deleted) while the job ran. Withdraws, and warns when a
 * soft-delete left no cancellation row to withdraw against: an id is never invented.
 */
async function withdrawProjectionForCancelledMeeting(
  data: BookingCalendarProjectionJobData
): Promise<void> {
  if (await withdrawIfCancelled(data)) return;
  jobLogger.warn(
    { meetingId: data.meetingId },
    'Meeting vanished during its calendar projection with no cancellation audit row — nothing to withdraw against'
  );
}

/**
 * The window moved while the job ran. A reschedule's own amend that fired before the expert's
 * provider row existed converged to nothing, so when a live provider row now exists the job
 * hands the new window to the amend queue itself. Never throws.
 */
async function amendIfWindowMoved(
  data: BookingCalendarProjectionJobData,
  projected: Meeting,
  current: Meeting
): Promise<void> {
  const { meetingId, expertProfileId } = data;
  const moved =
    current.scheduledStart.getTime() !== projected.scheduledStart.getTime() ||
    current.scheduledEnd.getTime() !== projected.scheduledEnd.getTime();
  if (!moved || expertProfileId === null) return;

  try {
    const providerEvent =
      await meetingCalendarEventsRepository.findLiveExpertProviderEvent(meetingId);
    if (providerEvent === undefined) return;
  } catch (error) {
    jobLogger.error(
      { meetingId, ...errorFields(error) },
      'Could not look up the expert provider event after the window moved — no amend enqueued'
    );
    return;
  }

  try {
    await enqueueMeetingCalendarAmend(
      meetingId,
      expertProfileId,
      bookingCalendarProjectionJobId(meetingId)
    );
  } catch (error) {
    await reportCalendarAmendEnqueueFailure(
      {
        meetingId,
        expertProfileId,
        newStart: current.scheduledStart,
        trigger: 'booking_projection',
        error,
      },
      jobLogger
    );
  }
}

/**
 * The handler (exported for unit testing without a Redis-backed Worker).
 *
 * BAL-607 — THE BOOKING CALENDAR PROJECTION, moved off the `POST /meetings` request path. The
 * booking and its venue have already committed; this job writes the calendar side.
 *
 * ⚠⚠ THE PAYLOAD CARRIES NO WINDOW. Every run RE-READS the meeting row and projects WHATEVER IS
 * THERE NOW, so a reschedule that committed between the enqueue and the run is projected at its
 * new time (`meeting-calendar-amend.ts` states the same rule for the amend).
 *
 * ```
 * P1  read the meeting. Missing or cancelled → report `skipped` for both parties, stop
 * P2  expert projection → expert emit → client row → client emit
 * P3  re-read. A read failure still looks for a cancellation (P4a), else falls through to P5
 * P4a missing or cancelled now → withdraw the projection P2 just wrote; NO invites
 * P4b window moved and a live provider row exists → enqueue the amend
 * P5  publish the invites
 * ```
 *
 * ⚠ P1 is the ONE unguarded await: a throw fails the job, which is kept in the failed set and
 * NOT retried (`attempts: 1`, `maxStalledCount: 0`) — a deliberate, accepted gap. Everything
 * after it is individually caught, so a partial failure never re-runs a non-idempotent vendor
 * create.
 */
export async function processBookingCalendarProjection(
  job: Job<BookingCalendarProjectionJobData>
): Promise<void> {
  const { data } = job;
  const { meetingId, expertProfileId } = data;

  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined || meeting.status === 'cancelled') {
    reportSkippedProjection(data);
    return;
  }

  await projectBothParties({ meeting, expertProfileId }, data);

  const reread = await rereadMeeting(meetingId);
  if (reread === 'unreadable') {
    if (await withdrawIfCancelled(data)) return;
  } else {
    const { meeting: current } = reread;
    if (current === undefined || current.status === 'cancelled') {
      await withdrawProjectionForCancelledMeeting(data);
      return;
    }
    await amendIfWindowMoved(data, meeting, current);
  }

  await publishBookingCalendarInvitesSafely(data);
}

export function startBookingCalendarProjectionWorker(): Worker<BookingCalendarProjectionJobData> {
  const worker = new Worker<BookingCalendarProjectionJobData>(
    BOOKING_CALENDAR_PROJECTION_QUEUE,
    processBookingCalendarProjection,
    {
      connection: createRedisConnection(),
      concurrency: 2,
      maxStalledCount: 0,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { meetingId: job?.data.meetingId, error: err.message, stack: err.stack },
      'Booking calendar projection failed — not retried'
    );
  });

  return worker;
}
