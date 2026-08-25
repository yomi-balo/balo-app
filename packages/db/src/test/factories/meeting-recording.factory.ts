import { db } from '../../client';
import { meetingRecordings } from '../../schema';
import type { MeetingRecording, NewMeetingRecording } from '../../schema';
import { meetingFactory } from './meeting.factory';

export interface MeetingRecordingFactoryResult {
  meetingId: string;
  recording: MeetingRecording;
}

/** Everything the factory accepts: raw column overrides plus an optional existing meeting. */
export type MeetingRecordingFactoryOverrides = Partial<NewMeetingRecording> & {
  meetingId?: string;
};

/**
 * Seeds ONE `meeting_recordings` row (BAL-473), plus its meeting when none is supplied.
 *
 * Inserts DIRECTLY via `db` rather than through `meetingRecordingsRepository`, on the
 * `meeting.factory` / `transcript.factory` precedent: the repository exposes only
 * `insertCapturing` (which always mints a `recording` row) and a set of compare-and-set
 * mutators, so a test could not otherwise seed a segment ALREADY in `source_ready`,
 * `ingesting`, `ready` or `failed` without driving the whole state machine to get there.
 *
 * ⚠⚠ `captureEndedAt` IS DERIVED FROM `status`, AND THAT IS LOAD-BEARING, NOT A CONVENIENCE.
 * The `meeting_recording_capture_slot` CHECK is `capture_ended_at IS NOT NULL OR status =
 * 'recording'`, so a caller asking for any non-`recording` status without also stamping
 * `capture_ended_at` would get a raw `23514` — and inside the integration harness's single
 * outer transaction that aborts the whole test (`25P02`), so the failure would surface far
 * from its cause. This factory therefore stamps `capture_ended_at` for every non-`recording`
 * status automatically.
 *
 * ⚠ THE DERIVATION IS OVERRIDABLE, DELIBERATELY. Passing `captureEndedAt` explicitly — including
 * `null` — wins, because the tests that probe the CHECK itself and the tests that probe the
 * capture slot need to construct exactly the states this default exists to prevent. A test
 * that passes `{ status: 'ready', captureEndedAt: null }` is asking for the violation and
 * should route through `expectConstraintViolation`.
 *
 * ⚠ A SECOND `recording`-STATUS ROW FOR THE SAME MEETING WILL FAIL `23505` on
 * `meeting_recording_capturing_idx` — that is the capture slot working, not a factory bug.
 * Seed the first segment as `source_ready`/`ready`/`failed` (which releases the slot) before
 * seeding a second capturing one, exactly as a real rejoin does.
 */
export async function meetingRecordingFactory(
  overrides: MeetingRecordingFactoryOverrides = {}
): Promise<MeetingRecordingFactoryResult> {
  const { meetingId: suppliedMeetingId, ...values } = overrides;
  const meetingId = suppliedMeetingId ?? (await meetingFactory()).meeting.id;

  const status = values.status ?? 'recording';
  // Only supplies the derivation when the caller named nothing — `...values` below then
  // carries any explicit override (including a deliberate `null`) straight through.
  const derived: Partial<NewMeetingRecording> =
    'captureEndedAt' in values
      ? {}
      : { captureEndedAt: status === 'recording' ? null : new Date() };

  const [recording] = await db
    .insert(meetingRecordings)
    .values({ meetingId, status, ...derived, ...values })
    .returning();
  if (recording === undefined) {
    throw new Error('meeting recording insert failed');
  }

  return { meetingId, recording };
}
