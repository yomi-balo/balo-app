import { meetings, meetingContexts } from '../../schema';
import { projectNewMeetingTx } from './consultation-projection';
import { recordMeetingBooked } from './meeting-audit';
import type { DbExecutor } from './db-executor';
// ⚠ TYPE-ONLY, the `cancel-meeting-tx.ts` precedent: `meetings.ts` imports the FUNCTION below,
// and this import is erased at compile time, so there is no runtime edge back.
import type { CreateMeetingInput, CreatedMeeting } from '../meetings';

/**
 * The TRANSACTIONAL CORE of a booking, on a `DbExecutor`, so that BOTH
 * `meetingsRepository.create` (which opens its own `db.transaction`) and
 * `meetingRingsRepository.startWithNewMeeting` (which must create the meeting and its ring in
 * ONE transaction) drive the same steps in the same order. See `meetingsRepository.create`'s
 * docblock for why each step is where it is; change the sequence HERE, never in a caller.
 *
 * ⚠ THE CALLER OWNS THE PRE-CHECKS. `create` throws `MeetingContextRequiredError` on an empty
 * `contexts` array and re-asserts `scheduledStart < scheduledEnd` BEFORE opening its
 * transaction; this core assumes both. `startWithNewMeeting` builds a one-element `contexts`
 * array by construction, and CHECK `meeting_scheduled_start_before_end` is the backstop for the
 * window.
 *
 * ── THE SEQUENCE, IN ORDER, ALL ON `exec` ─────────────────────────────────────
 *   1. Insert the meeting.
 *   2. Insert its context rows.
 *   3. `projectNewMeetingTx` — the `consultations` projection, which resolves the expert whose
 *      calendar this booking blocks (and throws, rolling the whole booking back, when the
 *      contexts name no single expert).
 *   4. `recordMeetingBooked` — the `meeting.booked` audit row, LAST: an audit row left behind
 *      by a rolled-back booking would attest to a booking that never existed.
 */
export async function createMeetingTx(
  exec: DbExecutor,
  input: CreateMeetingInput
): Promise<CreatedMeeting> {
  const [meeting] = await exec
    .insert(meetings)
    .values({
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      dailyRoomName: input.dailyRoomName ?? null,
      joinUrl: input.joinUrl ?? null,
      bookingIdempotencyKey: input.bookingIdempotencyKey ?? null,
    })
    .returning();
  if (meeting === undefined) {
    throw new Error('Failed to insert meeting');
  }

  const contexts = await exec
    .insert(meetingContexts)
    .values(
      input.contexts.map((context) => ({
        meetingId: meeting.id,
        contextType: context.contextType,
        contextId: context.contextId,
      }))
    )
    .returning();
  if (contexts.length !== input.contexts.length) {
    throw new Error(`Failed to attach contexts to meeting: ${meeting.id}`);
  }

  const expertProfileId = await projectNewMeetingTx(exec, meeting, input.contexts);

  // LAST, and on `exec` — never the base `db`. Written after the projection because
  // `expertProfileId` (whose calendar this booking blocked) is resolved there and is not
  // re-derivable later. Passing `db` here would leave an audit row behind after a rolled-back
  // booking, which is worse than no row: it would attest to a booking that never existed.
  await recordMeetingBooked(exec, {
    meetingId: meeting.id,
    actorUserId: input.actorUserId ?? null,
    contexts: input.contexts,
    scheduledStart: meeting.scheduledStart,
    scheduledEnd: meeting.scheduledEnd,
    expertProfileId,
  });

  return { meeting, contexts, expertProfileId };
}
