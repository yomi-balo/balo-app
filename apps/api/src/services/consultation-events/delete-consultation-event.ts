import { meetingCalendarEventsRepository } from '@balo/db';
import { getApirocClient, callApiroc } from '../../lib/apiroc/index.js';

export interface DeleteConsultationEventInput {
  readonly meetingId: string;
  /**
   * The Apiroc End User Account that owns the stored event. Caller-supplied rather than
   * re-derived from `meeting_calendar_events.connection_id`: the caller (BAL-400's cancel
   * flow) already holds the `CalendarConnection` it used to resolve the calendar in the
   * first place, and `calendarRepository` exposes no "get connection by id" read — every
   * sanctioned read is keyed by (expert, provider) or by End User Account, never by the bare
   * connection id (`packages/db/src/repositories/calendar.ts`).
   */
  readonly endUserAccountId: string;
}

/**
 * BAL-396 §5/§10.6 — reads the stored row for `(endUserAccountId, calendarId, vendorEventId)`,
 * soft-deletes Balo's record, then one `events.delete`. Ships INERT: no live caller until
 * BAL-400 wires cancellation.
 *
 * ⚠ USES THE STORED `calendarId`, NEVER THE CURRENT `target_calendar_id` — the expert may have
 * changed their target calendar since the event was written; the delete must address the
 * calendar the event actually lives in.
 *
 * `undefined` from `findLiveExpertProviderEvent` means "nothing to delete at the vendor" — never
 * written (no connected calendar, or a BAL-433 ICS-fallback meeting), or already cancelled. A
 * no-op, not an error.
 *
 * ⚠ EXPERT-PARTY ONLY, BOTH READ AND WRITE (BAL-433). The read is narrowed to
 * `party='expert' AND delivery_mode='provider_event'` — an ICS-fallback row names no vendor
 * event to delete — and the soft delete is party-scoped so a vendor failure on the EXPERT's
 * calendar cannot take a client-party row with it.
 *
 * ⚠⚠ round-2 fix #14 — MARK BALO'S ROW FIRST, DELETE AT THE VENDOR SECOND. This resolves a
 * contradiction with an earlier revision of this function, which did the opposite and
 * directly contradicted `meetingCalendarEventsRepository.softDeleteByMeetingAndParty`'s own
 * docstring ("Marking first and deleting after is the right order"). That docstring's
 * reasoning is what this order follows: if the process dies between the two calls, marking
 * first leaves an ORPHANED VENDOR EVENT — still tagged with `baloBookingId`, and therefore
 * recoverable later via `reconcileByTag`. Deleting the vendor first would instead risk a LOST
 * BALO ROW on a crash between the two calls: Balo keeps believing it owns a live event the
 * vendor has already discarded, with nothing left at the vendor to reconcile against. A
 * vendor-delete failure after the mark therefore does NOT roll the mark back — that is the
 * accepted tradeoff, not an oversight.
 */
export async function deleteConsultationEvent(input: DeleteConsultationEventInput): Promise<void> {
  const row = await meetingCalendarEventsRepository.findLiveExpertProviderEvent(input.meetingId);
  if (!row) return;

  await meetingCalendarEventsRepository.softDeleteByMeetingAndParty(input.meetingId, 'expert');

  const client = getApirocClient();
  await callApiroc('events.delete', () =>
    client.events.delete(input.endUserAccountId, row.calendarId, row.vendorEventId)
  );
}
