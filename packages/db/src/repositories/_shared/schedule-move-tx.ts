import { GUEST_TOKEN_TTL_AFTER_END_MS } from '@balo/shared/meetings';
import type { Meeting } from '../../schema';
import { syncProjectionScheduleTx } from './consultation-projection';
import {
  bumpCalendarSequencesForMeetingTx,
  type MeetingCalendarSequenceBump,
} from './calendar-sequence';
import { extendGuestExpiryForMeetingTx } from './guest-expiry';
import { recordMeetingRescheduled, type MeetingRescheduleReason } from './meeting-audit';
import type { DbExecutor } from './db-executor';

/** What {@link applyScheduleMoveTx} hands back to the caller that moved the window. */
export interface ScheduleMoveResult {
  /** Whose availability cache to rebuild post-commit; `null` when nothing is projected. */
  expertProfileId: string | null;
  /** How many live guest links moved. `0` on a move EARLIER — extend-only, not a bug. */
  guestLinksExtended: number;
  /** Every live calendar row, AFTER its SEQUENCE bump (client first, then expert). */
  calendarEvents: MeetingCalendarSequenceBump[];
  /** The `meeting.rescheduled` audit row's id — the per-WRITE fan-out idempotency key. */
  rescheduleAuditId: string;
}

/**
 * The FOLLOW-THROUGH of a meeting window move, on a `DbExecutor`: everything that must change in
 * the SAME transaction once `meetings.scheduled_start` / `scheduled_end` have been written. Shared
 * by `meetingsRepository.updateSchedule` (a reschedule) and `meetingRingsRepository.connect` (a
 * Call now ring connecting moves its meeting's start to the connect instant), so both move the
 * projection, the guest links, the calendar SEQUENCE and the audit trail identically.
 *
 * ⚠ THE CALLER HAS ALREADY WRITTEN THE NEW WINDOW, under a `FOR UPDATE` lock on the meeting row
 * taken in the same transaction, and passes the moved row plus the pre-image it read under that
 * lock. That lock is what makes one committed move exactly one SEQUENCE bump.
 *
 * ── THE SEQUENCE, IN ORDER, ALL ON `exec` ─────────────────────────────────────
 *   1. `syncProjectionScheduleTx` — moves the `consultations` projection.
 *   2. `extendGuestExpiryForMeetingTx` — extends every live guest link (extend-only, so a move
 *      EARLIER shortens nothing).
 *   3. `bumpCalendarSequencesForMeetingTx` — +1 on every live calendar row's RFC 5545 SEQUENCE.
 *   4. `recordMeetingRescheduled` — the `meeting.rescheduled` audit row, LAST among the writes.
 */
export async function applyScheduleMoveTx(
  exec: DbExecutor,
  meeting: Meeting,
  previous: { scheduledStart: Date; scheduledEnd: Date },
  audit: { actorUserId: string | null; reason?: MeetingRescheduleReason }
): Promise<ScheduleMoveResult> {
  const expertProfileId = await syncProjectionScheduleTx(exec, meeting);

  const guestLinksExtended = await extendGuestExpiryForMeetingTx(
    exec,
    meeting.id,
    new Date(meeting.scheduledEnd.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS)
  );

  const calendarEvents = await bumpCalendarSequencesForMeetingTx(exec, meeting.id);

  const rescheduleAuditId = await recordMeetingRescheduled(exec, {
    meetingId: meeting.id,
    actorUserId: audit.actorUserId,
    previous,
    scheduledStart: meeting.scheduledStart,
    scheduledEnd: meeting.scheduledEnd,
    expertProfileId,
    guestLinksExtended,
    reason: audit.reason,
  });

  return { expertProfileId, guestLinksExtended, calendarEvents, rescheduleAuditId };
}
