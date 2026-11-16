/**
 * BAL-649 (decisions 1 & 4) — CONNECTING A RING: both parties are present while it still rings.
 *
 * Called by `reconcileMeetingStatus` (WP E) on co-presence. The repository does the whole write
 * in one transaction (ring `connected`, the meeting started at the connect instant, its window
 * moved, the projection and calendar SEQUENCE bumped, one `meeting.rescheduled` row). This
 * service adds the post-commit tail:
 *   · availability rebuild (the projection moved);
 *   · for an `in_place` ring with an expert, the retrying Apiroc calendar amend, keyed on the
 *     `meeting.rescheduled` audit id;
 *   · `call.connected` and `call_now_ring_ended`.
 *
 * ⚠⚠ DELIBERATELY NOT CALLED: `publishGuestRescheduledNotifications`,
 * `publishRescheduleCalendarInvites` and `booking.rescheduled`. The copy sheet says a connect
 * sends "No message on any channel": both parties are already in the room, and guests keep their
 * links. The calendar amend is a quiet convergence of the expert's own calendar, not a message.
 *
 * ⚠ `{ connected: false }` IS A NORMAL OUTCOME: no ring, an expired or ended ring, or a lost
 * race to expiry / decline / stop. The caller falls through to the ordinary presence path.
 */
import { meetingRingsRepository, type Meeting, type MeetingRing } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type { FastifyBaseLogger } from 'fastify';
import { enqueueMeetingCalendarAmend } from '../../jobs/meeting-calendar-amend.js';
import { reportCalendarAmendEnqueueFailure } from '../meetings/meeting-availability.js';
import { publishCallEvent, trackRingEnded } from './call-now-events.js';
import { rebuildAvailabilityBestEffort } from './post-commit.js';

const log = createLogger('call-now-connect');

export type ConnectRingResult =
  | { connected: true; meeting: Meeting; ring: MeetingRing }
  | { connected: false };

async function amendCalendarBestEffort(input: {
  meeting: Meeting;
  expertProfileId: string;
  rescheduleAuditId: string;
}): Promise<void> {
  const { meeting, expertProfileId, rescheduleAuditId } = input;
  try {
    await enqueueMeetingCalendarAmend(meeting.id, expertProfileId, rescheduleAuditId);
  } catch (error) {
    try {
      await reportCalendarAmendEnqueueFailure(
        {
          meetingId: meeting.id,
          expertProfileId,
          newStart: meeting.scheduledStart,
          trigger: 'reschedule',
          error,
        },
        log as unknown as FastifyBaseLogger
      );
    } catch (reportError) {
      log.warn(
        {
          meetingId: meeting.id,
          error: reportError instanceof Error ? reportError.message : String(reportError),
        },
        'Calendar amend enqueue failure could not be reported'
      );
    }
  }
}

export async function connectRingIfRinging(input: {
  meeting: Meeting;
  now: Date;
}): Promise<ConnectRingResult> {
  const { meeting, now } = input;

  const ringing = await meetingRingsRepository.findRingingForMeeting(meeting.id);
  if (ringing === undefined) {
    return { connected: false };
  }

  const connected = await meetingRingsRepository.connect({ ringId: ringing.id, startedAt: now });
  if (connected === undefined) {
    log.info(
      { ringId: ringing.id, meetingId: meeting.id },
      'Call now connect missed — the ring ended first'
    );
    return { connected: false };
  }

  const { ring, expertProfileId } = connected;
  const moved = connected.meeting;

  await rebuildAvailabilityBestEffort(expertProfileId, log);
  if (ring.placement === 'in_place' && expertProfileId !== null) {
    await amendCalendarBestEffort({
      meeting: moved,
      expertProfileId,
      rescheduleAuditId: connected.rescheduleAuditId,
    });
  }

  await publishCallEvent('call.connected', ring);
  trackRingEnded(ring);
  log.info(
    {
      ringId: ring.id,
      meetingId: moved.id,
      placement: ring.placement,
      fromStart: connected.previous.scheduledStart.toISOString(),
      toStart: moved.scheduledStart.toISOString(),
    },
    'Call now ring connected'
  );
  return { connected: true, meeting: moved, ring };
}
