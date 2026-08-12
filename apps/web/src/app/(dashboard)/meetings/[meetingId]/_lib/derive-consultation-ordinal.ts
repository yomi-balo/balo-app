import type { MeetingOutcome, MeetingStatus } from '@balo/db';

/**
 * BAL-388 — the ORDINAL LINE derivation. PURE: no I/O, no `db`, no clock.
 *
 * The recap cannot link back to the case (BAL-421 and `/cases` do not exist), so this line is
 * what answers "which consultation of which case is this". It is also the source
 * `engagement.case_closed`'s `consultationCount` has wanted and never had.
 *
 * ⚠⚠ THE INPUT TYPE IS NARROWED ON PURPOSE — IT IS A PII/SECRET BOUNDARY, NOT TIDINESS.
 * `meetingContextsRepository.listMeetingsForContext` returns FULL `Meeting` rows, including
 * `dailyRoomName` and `joinUrl` — a live room locator. This function accepts only the five
 * fields the ordering needs and returns two NUMBERS, so no meeting row can reach the client
 * through it. Do not widen `MeetingOrdinalInput` to `Meeting`.
 *
 * ⚠ IT RE-SORTS RATHER THAN TRUSTING THE QUERY. The shipped repository orders by
 * `(scheduled_start, id)`; the rule is `COALESCE(started_at, scheduled_start) ASC, id ASC`. A
 * meeting that started late — or was rescheduled — would otherwise be numbered by when it was
 * BOOKED rather than when it HAPPENED. The `id` tiebreak keeps the answer stable, so the same
 * page never renders a different ordinal on refresh.
 *
 * ⚠ N+1 IS CLOSED BY CONSTRUCTION: the caller makes ONE query for the whole sibling set and
 * hands it here. There is no per-meeting read anywhere in this derivation.
 */

/** Exactly what the ordering reads. NEVER the full `Meeting` row — see above. */
export interface MeetingOrdinalInput {
  id: string;
  scheduledStart: Date;
  startedAt: Date | null;
  status: MeetingStatus;
  outcome: MeetingOutcome | null;
}

export interface ConsultationOrdinal {
  /**
   * 1-based position among the case's NON-CANCELLED meetings, or `null`.
   *
   * `null` means the line is OMITTED and the party card must still read complete — it is a
   * garnish, never the card's structure. Three ways to get it: this meeting is `cancelled`
   * (it was never a consultation), the sibling set is empty, or this meeting is not in it.
   */
  ordinal: number | null;
  /**
   * How many of the case's consultations were actually HELD (`ended` + `completed`).
   * Feeds `consultationCount` on the `engagement.case_closed` payload.
   */
  heldCount: number;
}

/** When a meeting HAPPENED: `started_at` if it did, else when it was due to. */
function occurredAt(meeting: MeetingOrdinalInput): number {
  return (meeting.startedAt ?? meeting.scheduledStart).getTime();
}

/** `COALESCE(started_at, scheduled_start) ASC, id ASC` — total, stable, deterministic. */
function byOccurrenceThenId(a: MeetingOrdinalInput, b: MeetingOrdinalInput): number {
  const delta = occurredAt(a) - occurredAt(b);
  if (delta !== 0) return delta;
  return a.id.localeCompare(b.id);
}

/**
 * Derive this meeting's ordinal within its case, plus how many of the case's consultations
 * were held.
 *
 * ⚠ A NOT-HELD MEETING **DOES** GET AN ORDINAL. It occupied a slot, and "4th consultation on
 * this case" is exactly the context that makes a no-show legible rather than mysterious. Only
 * `cancelled` is excluded — a cancelled slot was never a consultation.
 */
export function deriveConsultationOrdinal(
  siblings: readonly MeetingOrdinalInput[],
  meetingId: string
): ConsultationOrdinal {
  const heldCount = siblings.filter(
    (meeting) => meeting.status === 'ended' && meeting.outcome === 'completed'
  ).length;

  const ordered = siblings
    .filter((meeting) => meeting.status !== 'cancelled')
    .slice()
    .sort(byOccurrenceThenId);

  const index = ordered.findIndex((meeting) => meeting.id === meetingId);
  return { ordinal: index === -1 ? null : index + 1, heldCount };
}

/** en-AU ordinal suffix: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st … */
export function ordinalSuffix(value: number): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return 'th';
  const last = value % 10;
  if (last === 1) return 'st';
  if (last === 2) return 'nd';
  if (last === 3) return 'rd';
  return 'th';
}

/** The rendered line, or `null` when there is no ordinal to state. */
export function formatOrdinalLine(ordinal: number | null): string | null {
  if (ordinal === null) return null;
  return ordinal + ordinalSuffix(ordinal) + ' consultation on this case';
}
