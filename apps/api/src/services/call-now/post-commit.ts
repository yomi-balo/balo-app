/**
 * BAL-649 — THE POST-COMMIT STEPS EVERY RING TRANSITION SHARES.
 *
 * `meetingRingsRepository` cannot reach a queue or Daily (`repositories-never-notify`), so its
 * callers owe these after commit. Each step is BEST-EFFORT: the ring's compare-and-set has
 * already committed and nothing here may change the answer the caller earned, so a failure logs
 * at `warn` and is swallowed.
 */
import type { Meeting } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type { FastifyBaseLogger } from 'fastify';
import { enqueueAvailabilityCacheRebuild } from '../../jobs/availability-cache.js';
import { dailyRoomTeardown } from '../daily/rooms.js';
import { emitMeetingEnded } from '../meetings/end-meeting.js';

export type CallNowLogger = ReturnType<typeof createLogger>;

/** A `FastifyBaseLogger`-shaped view of a scoped Pino logger (the calendar health probe's idiom). */
function asFastifyLogger(log: CallNowLogger): FastifyBaseLogger {
  return log as unknown as FastifyBaseLogger;
}

function errorFields(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

/** Rebuild the expert's availability cache so a released (or moved) slot is re-advertised. */
export async function rebuildAvailabilityBestEffort(
  expertProfileId: string | null,
  log: CallNowLogger
): Promise<void> {
  if (expertProfileId === null) {
    return;
  }
  try {
    await enqueueAvailabilityCacheRebuild(expertProfileId, asFastifyLogger(log));
  } catch (error) {
    log.warn(
      { expertProfileId, ...errorFields(error) },
      'Call now availability rebuild could not be enqueued'
    );
  }
}

/**
 * Everything owed after a meeting ended as `no_answer`: rebuild availability, delete the Daily
 * room, emit `meeting_ended`.
 *
 * ⚠ NEVER settlement, recording-stop or a credit-hold release: an unanswered call has no money
 * and no recording to unwind (AC1). `emitMeetingEnded` takes the instant `now` explicitly so a
 * slow teardown cannot inflate the figures it reports.
 */
export async function runNoAnswerTail(
  input: { meeting: Meeting; expertProfileId: string | null; now: Date },
  log: CallNowLogger
): Promise<void> {
  const { meeting, expertProfileId, now } = input;

  await rebuildAvailabilityBestEffort(expertProfileId, log);

  if (meeting.dailyRoomName !== null) {
    try {
      await dailyRoomTeardown.deleteRoom(meeting.dailyRoomName);
    } catch (error) {
      log.warn(
        { meetingId: meeting.id, roomName: meeting.dailyRoomName, ...errorFields(error) },
        'Daily room teardown failed after a no-answer end — rejoin is already refused Balo-side'
      );
    }
  }

  try {
    await emitMeetingEnded({ meeting, endedBy: 'system_idle', actorUserId: null, now });
  } catch (error) {
    log.warn(
      { meetingId: meeting.id, ...errorFields(error) },
      'meeting_ended could not be emitted'
    );
  }
}
