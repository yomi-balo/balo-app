/**
 * BAL-474 (D8.6, plan AD-18) — THE ONE DEFINITION OF "this booking idempotency key names this
 * booking". Moved here from `apps/api/src/services/meetings/provision-meeting.ts`
 * (`lookupBookingReplay`, BAL-400 S3/M1) so that `POST /meetings` (which must consult it before
 * its availability and funding gates, and again inside the service) and the web booking action
 * (which skips its advisory funding gates for a lost-201 replay) classify a key IDENTICALLY. A
 * second, drifting copy of this predicate is exactly how a replay starts resolving to a meeting
 * the client never asked for — or how a web gate refuses a retry the API would have replayed.
 *
 *   `none`     — no meeting exists under this key yet: the caller creates one.
 *   `match`    — the key names THIS booking: the SAME window AND a context that is this booking's
 *                context. Replay it (and read no hold or reservation — it is already booked).
 *   `conflict` — the key names a DIFFERENT booking (another window, or another context). Refuse
 *                with `409 idempotency_key_conflict`, before any funding check.
 *
 * ⚠⚠ THE WINDOW COMPARISON IS NOT OPTIONAL: a key that resolves to a DIFFERENT window is a
 * CONFLICT, never a silent replay. The client's own wrapper freezes the nonce after a failed
 * meeting hop, so a user who then picks a different time would otherwise be silently booked at
 * the ORIGINAL time. "That key is already spent on another booking" is the only answer that
 * cannot lie.
 *
 * ⚠ ORDER: the window is compared FIRST, because it costs a caller no second read —
 * {@link bookingReplayWindowMatches} is exported so a caller can decide whether to read the
 * meeting's contexts at all, without restating the comparison.
 *
 * ⚠ EXACT-DUPLICATE CONTEXT ROWS ARE NOT AMBIGUITY: the context check asks whether ANY live
 * context of the existing meeting is the probe's `(type, id)`.
 *
 * PURE — no I/O. Callers do the reads.
 */

export interface BookingReplayWindow {
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
}

export interface BookingReplayProbe extends BookingReplayWindow {
  readonly contextType: string;
  readonly contextId: string;
}

export interface BookingReplayExisting extends BookingReplayWindow {
  readonly contexts: readonly { readonly contextType: string; readonly contextId: string | null }[];
}

export type BookingReplayClassification = 'none' | 'match' | 'conflict';

/** The window half of the classification — the same instants, to the millisecond. */
export function bookingReplayWindowMatches(
  existing: BookingReplayWindow,
  probe: BookingReplayWindow
): boolean {
  return (
    existing.scheduledStart.getTime() === probe.scheduledStart.getTime() &&
    existing.scheduledEnd.getTime() === probe.scheduledEnd.getTime()
  );
}

export function classifyBookingReplay(
  existing: BookingReplayExisting | undefined,
  probe: BookingReplayProbe
): BookingReplayClassification {
  if (existing === undefined) {
    return 'none';
  }
  if (!bookingReplayWindowMatches(existing, probe)) {
    return 'conflict';
  }
  const matchesContext = existing.contexts.some(
    (context) => context.contextType === probe.contextType && context.contextId === probe.contextId
  );
  return matchesContext ? 'match' : 'conflict';
}
