import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { meetingCalendarEvents, type MeetingCalendarEvent } from '../schema';

/**
 * BAL-396 §5 — the record of ONE consultation event written into an expert's own calendar.
 *
 * ⚠⚠ THE IDEMPOTENCY KEY IS BALO'S OWN `meeting_id`, NEVER A DERIVED VENDOR ID. Microsoft
 * answers HTTP 200 to a caller-supplied event `id` and silently substitutes a Graph id
 * (apiroc skill §M1), so a design that keys idempotency on "the id we asked for" passes every
 * Google test and then double-books Microsoft experts in production only. Here the vendor's
 * answer is STORED (`vendorEventId`) and the retry key is the partial unique on `meeting_id`.
 *
 * ⚠ THIS REPOSITORY NEVER NOTIFIES. Its rows are written from a path that will notify once
 * booking is wired, and from inside meeting-mutation flows — so the publish belongs at the
 * call site, post-commit. Pinned by `invariants/repositories-never-notify.test.ts`.
 */
export interface RecordCalendarEventInput {
  meetingId: string;
  connectionId: string;
  /**
   * The calendar actually written to, AT WRITE TIME — not
   * `calendar_connections.target_calendar_id`, which the expert may change afterwards. The
   * delete/patch call needs the original.
   */
  calendarId: string;
  /** ⚠ THE VALUE THE VENDOR RETURNED. Never the id the caller asked for — see above. */
  vendorEventId: string;
  /** Exactly what was written to `privateExtendedProperties.baloBookingId`. */
  baloBookingId: string;
}

export const meetingCalendarEventsRepository = {
  /**
   * Record (or re-record) the live vendor event for one meeting.
   *
   * ⚠⚠ THE ARBITER MUST RESTATE `targetWhere`. `meeting_calendar_event_meeting_uq` is
   * PARTIAL on `deleted_at IS NULL`, and Postgres only selects a partial index as an
   * ON CONFLICT arbiter when the statement REPEATS its predicate. Omit it and EVERY call
   * raises **42P10** at PLAN time — the first one, on an empty table, with `tsc` and any
   * mocked unit test green. Same trap, same shape as
   * `calendarRepository.upsertApirocConnection`.
   *
   * ⚠ A RETRIED WRITE UPDATES; A REBOOK INSERTS. If a live row exists for this meeting the
   * DO UPDATE arm overwrites it (the retry case — the vendor may have answered with a
   * different id on the second attempt). A soft-deleted row is invisible to the partial
   * index, so a cancelled-then-rebooked meeting INSERTs a second row and the old one stays
   * as history. `deletedAt` is deliberately NOT reset in the update arm: the only row this
   * arm can reach is already live, so resetting it would only ever mask a mistake.
   */
  async record(input: RecordCalendarEventInput): Promise<MeetingCalendarEvent> {
    const [result] = await db
      .insert(meetingCalendarEvents)
      .values({
        meetingId: input.meetingId,
        connectionId: input.connectionId,
        calendarId: input.calendarId,
        vendorEventId: input.vendorEventId,
        baloBookingId: input.baloBookingId,
      })
      .onConflictDoUpdate({
        target: [meetingCalendarEvents.meetingId],
        // ⚠⚠ See the warning above. Removing this line breaks EVERY write with 42P10.
        targetWhere: isNull(meetingCalendarEvents.deletedAt),
        set: {
          connectionId: input.connectionId,
          calendarId: input.calendarId,
          vendorEventId: input.vendorEventId,
          baloBookingId: input.baloBookingId,
          updatedAt: new Date(),
        },
      })
      .returning();

    return result!;
  },

  /**
   * The live vendor event for one meeting, if Balo wrote one.
   *
   * `undefined` genuinely means "no live calendar event for this meeting" — either it was
   * never written (the expert has no connection, or the write failed) or it was cancelled.
   * A caller deleting a vendor event must treat `undefined` as "nothing to delete", never as
   * an error.
   */
  async findLiveByMeetingId(meetingId: string): Promise<MeetingCalendarEvent | undefined> {
    return db.query.meetingCalendarEvents.findFirst({
      where: and(
        eq(meetingCalendarEvents.meetingId, meetingId),
        isNull(meetingCalendarEvents.deletedAt)
      ),
    });
  },

  /**
   * Every live vendor event written through ONE connection, oldest first.
   *
   * The disconnect path's sweep list: when an expert disconnects a provider, the events Balo
   * put in THAT calendar are the ones it may still address (a different connection's events
   * live in a different vendor account and are unreachable with this pointer).
   */
  async listLiveByConnectionId(connectionId: string): Promise<MeetingCalendarEvent[]> {
    return db.query.meetingCalendarEvents.findMany({
      where: and(
        eq(meetingCalendarEvents.connectionId, connectionId),
        isNull(meetingCalendarEvents.deletedAt)
      ),
      orderBy: [asc(meetingCalendarEvents.createdAt), asc(meetingCalendarEvents.id)],
    });
  },

  /**
   * Soft-delete the live record for one meeting — the cancel/reschedule path.
   *
   * ⚠ SOFT DELETE ONLY, and that is what makes rebooking work: the partial unique ignores
   * this row, so the next write for the same meeting INSERTs beside it instead of failing
   * 23505 against a row the application cannot see
   * (`reference_softdelete_nonpartial_unique_recreate`).
   *
   * ⚠ THIS DOES NOT TOUCH THE VENDOR. Deleting the calendar event at the provider is the
   * caller's separate obligation; this only stops Balo claiming a live event it no longer
   * owns. Marking first and deleting after is the right order — an orphaned vendor event is
   * recoverable via `balo_booking_id`, a lost row is not.
   */
  async softDeleteByMeetingId(meetingId: string): Promise<void> {
    await db
      .update(meetingCalendarEvents)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(meetingCalendarEvents.meetingId, meetingId), isNull(meetingCalendarEvents.deletedAt))
      );
  },
};
