/**
 * BAL-651 — `origin` for `meeting_ended` and `session_settled`: was this meeting created by a Call
 * now ring (`call_now`) or booked (`booked`)? Derived from the ring rows, never stored.
 *
 * A meeting with no id (a session with no meeting) is `booked`. A ring that rode a booking in
 * place leaves the meeting `booked`, because only a `new_meeting` ring creates one.
 *
 * Best-effort: the value only labels analytics and a receipt, and callers sit on money paths
 * (settlement receipts, hold dunning, meeting end), so a failed read falls back to `booked`.
 */
import { meetingRingsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { callNowFactsFromRings, type CallNowFacts } from '@balo/shared/meetings';

const log = createLogger('call-now-meeting-origin');

export async function meetingOrigin(meetingId: string | null): Promise<CallNowFacts['origin']> {
  if (meetingId === null) {
    return 'booked';
  }
  try {
    const rings = await meetingRingsRepository.listFactsForMeetings([meetingId]);
    return callNowFactsFromRings(rings).origin;
  } catch (error) {
    log.warn(
      { meetingId, error: error instanceof Error ? error.message : String(error) },
      'Meeting origin read failed — falling back to booked'
    );
    return 'booked';
  }
}
