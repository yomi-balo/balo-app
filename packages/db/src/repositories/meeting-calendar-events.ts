import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { meetingCalendarEvents } from '../schema';
import type { MeetingCalendarEvent, MeetingParticipantParty } from '../schema';

/**
 * BAL-396 §5, widened by BAL-433 — the record of what ONE PARTY'S calendar entry for one
 * meeting became: a provider event written into a connected calendar, or the ICS fallback
 * condition (ADR-1044 amendment 2026-08-25, Ruling 1).
 *
 * ⚠⚠ THE IDEMPOTENCY KEY IS BALO'S OWN `(meeting_id, party)`, NEVER A DERIVED VENDOR ID.
 * Microsoft answers HTTP 200 to a caller-supplied event `id` and silently substitutes a Graph
 * id (apiroc skill §M1), so a design that keys idempotency on "the id we asked for" passes
 * every Google test and then double-books Microsoft experts in production only. Here the
 * vendor's answer is STORED (`vendorEventId`) and the retry key is the partial unique on
 * `(meeting_id, party)`.
 *
 * ⚠ "A PROVIDER WRITE **OR** AN ICS, NEVER BOTH" IS THE UNIQUE INDEX, NOT A CONVENTION HERE.
 * There is one live row per `(meeting, party)`; `deliveryMode` says which answer it holds,
 * and the biconditional CHECK `meeting_calendar_event_delivery_payload` keeps the four
 * provider columns consistent with it. That is why BOTH writers below must null the columns
 * their mode does not own in the DO UPDATE arm — a `provider_event` → `ics` transition that
 * left stale vendor ids raises **23514**. ⚠ AND IT IS WHY `recordIcsDelivery` REFUSES THAT
 * TRANSITION OUTRIGHT rather than performing it: nulling those columns on a row that names a
 * real vendor event ORPHANS the event on the expert's calendar. See its docblock.
 *
 * ⚠ SLICE 1 RECORDS THE ICS CONDITION AND SENDS NOTHING. Building and delivering the ICS is
 * BAL-475; `METHOD:CANCEL` is BAL-476. Nothing in this file talks to a transport.
 *
 * ⚠ THIS REPOSITORY NEVER NOTIFIES. Its rows are written from booking and meeting-mutation
 * flows that DO notify — so the publish belongs at the call site, post-commit. Pinned by
 * `invariants/repositories-never-notify.test.ts`.
 */

/**
 * The two sides a calendar entry can belong to — narrower than the reused three-label
 * `meeting_participant_party` enum, and exactly what the CHECK
 * `meeting_calendar_event_party_two_sided` permits. Mirrors `MeetingFileParty` /
 * `MeetingGuestParty`.
 */
export type MeetingCalendarEventParty = Extract<MeetingParticipantParty, 'client' | 'expert'>;

/**
 * A row Balo can actually ADDRESS AT THE VENDOR. The four provider columns are nullable on
 * the table (an `ics` row carries none of them) but NON-NULLABLE here, so a caller that got
 * one of these can call `events.update` / `events.delete` without a `!` anywhere.
 */
export type MeetingCalendarProviderEvent = MeetingCalendarEvent & {
  connectionId: string;
  calendarId: string;
  vendorEventId: string;
  baloBookingId: string;
};

export interface RecordProviderEventInput {
  meetingId: string;
  /**
   * ⚠ STRUCTURAL, NEVER A REQUEST FIELD. Every provider event a WRITER produces today is the
   * EXPERT's: `endUserAccountId` comes off a `calendar_connections` row and that table is
   * keyed on `expert_profile_id`. Typed rather than hardcoded so the column stays honest
   * about its grain.
   *
   * ⚠ SO "provider_event ⇒ expert" IS A PROPERTY OF THE WRITERS, NOT A CONSTRAINT. Nothing
   * enforces it — this parameter accepts either label, and the integration suite deliberately
   * writes a client-party provider row to isolate `findLiveExpertProviderEvent`'s party
   * filter. Any read that needs the expert's row must SAY `party = 'expert'`, which is
   * exactly what that method does.
   */
  party: MeetingCalendarEventParty;
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

export interface RecordIcsDeliveryInput {
  meetingId: string;
  party: MeetingCalendarEventParty;
}

/**
 * Does this row name a vendor event Balo can address? Impossible to fail under the
 * biconditional CHECK — kept as a TYPE GUARD (never a `!`, never an `as`) so the narrowed
 * row type is earned rather than asserted.
 */
function isProviderEvent(row: MeetingCalendarEvent): row is MeetingCalendarProviderEvent {
  return (
    row.connectionId !== null &&
    row.calendarId !== null &&
    row.vendorEventId !== null &&
    row.baloBookingId !== null
  );
}

export const meetingCalendarEventsRepository = {
  /**
   * Record (or re-record) the live PROVIDER EVENT for one (meeting, party).
   *
   * ⚠⚠ THE ARBITER MUST RESTATE `targetWhere`. `meeting_calendar_event_meeting_party_uq` is
   * PARTIAL on `deleted_at IS NULL`, and Postgres only selects a partial index as an
   * ON CONFLICT arbiter when the statement REPEATS its predicate. Omit it and EVERY call
   * raises **42P10** at PLAN time — the first one, on an empty table, with `tsc` and any
   * mocked unit test green. Same trap, same shape as
   * `calendarRepository.upsertApirocConnection`.
   *
   * ⚠ A RETRIED WRITE UPDATES; A REBOOK INSERTS. If a live row exists for this
   * (meeting, party) the DO UPDATE arm overwrites it (the retry case — the vendor may have
   * answered with a different id on the second attempt). A soft-deleted row is invisible to
   * the partial index, so a cancelled-then-rebooked meeting INSERTs a second row and the old
   * one stays as history. `deletedAt` is deliberately NOT reset in the update arm: the only
   * row this arm can reach is already live, so resetting it would only ever mask a mistake.
   */
  async recordProviderEvent(input: RecordProviderEventInput): Promise<MeetingCalendarEvent> {
    const [result] = await db
      .insert(meetingCalendarEvents)
      .values({
        meetingId: input.meetingId,
        party: input.party,
        deliveryMode: 'provider_event',
        connectionId: input.connectionId,
        calendarId: input.calendarId,
        vendorEventId: input.vendorEventId,
        baloBookingId: input.baloBookingId,
      })
      .onConflictDoUpdate({
        target: [meetingCalendarEvents.meetingId, meetingCalendarEvents.party],
        // ⚠⚠ See the warning above. Removing this line breaks EVERY write with 42P10.
        targetWhere: isNull(meetingCalendarEvents.deletedAt),
        set: {
          // The FULL discriminated payload — an `ics` row upgrading to a provider write must
          // end up holding every provider column, or the biconditional CHECK rejects it.
          deliveryMode: 'provider_event',
          connectionId: input.connectionId,
          calendarId: input.calendarId,
          vendorEventId: input.vendorEventId,
          baloBookingId: input.baloBookingId,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (result === undefined) {
      throw new Error('Failed to record the provider calendar event');
    }
    return result;
  },

  /**
   * Record the ICS-FALLBACK CONDITION for one (meeting, party) — ADR-1044 Ruling 1.
   *
   * ⚠ THIS SENDS NOTHING AND PROMISES NOTHING. It persists the fact that this party has no
   * writable provider calendar, so the delivery slice (BAL-475) has a durable row to work
   * from instead of re-deriving the condition off `calendar_connections`. There is no
   * `delivered_at`, no status and no reason column: a column with no reader is a stub.
   *
   * ⚠⚠ IT REFUSES TO OVERWRITE A LIVE `provider_event` ROW, AND THAT REFUSAL IS THE POINT OF
   * `setWhere`. The DO UPDATE arm nulls all four provider columns — it MUST, because a row
   * transitioning to `ics` while keeping a stale `vendor_event_id` violates
   * `meeting_calendar_event_delivery_payload` (**23514**). But nulling them on a row that
   * names a REAL vendor event destroys the only way Balo can address it (`connection_id` +
   * `calendar_id` + `vendor_event_id`) WITHOUT deleting anything at the provider: the event
   * stays on the expert's external calendar for good, blocking a window Balo no longer
   * believes in, and Balo can no longer reach it. So the update is gated on the existing row
   * already being `ics`; a live `provider_event` row updates nothing, returns nothing, and
   * this method THROWS.
   *
   * ⚠ UNREACHABLE TODAY, DELIBERATELY GUARDED ANYWAY. The single caller
   * (`projectBookingToExpertCalendar`) runs once per FRESH booking, before any provider row
   * for that (meeting, party) can exist, and its call is inside a `try` that degrades to
   * `'failed'` plus an error log. It becomes reachable the moment BAL-475/476, a disconnect
   * sweep, or any repair path records an ICS fallback for a meeting that already HAS a
   * provider event.
   *
   * ⚠ THE SANCTIONED ORDER FOR THAT TRANSITION, when it is genuinely wanted: delete the event
   * at the vendor, `softDeleteByMeetingAndParty(meetingId, party)`, THEN record the ICS. The
   * partial unique ignores the soft-deleted row, so this INSERTs beside it — which is why the
   * refusal costs a caller nothing except the vendor delete it owed anyway.
   *
   * ⚠ `targetWhere` — same partial index, same 42P10, see `recordProviderEvent`.
   */
  async recordIcsDelivery(input: RecordIcsDeliveryInput): Promise<MeetingCalendarEvent> {
    const [result] = await db
      .insert(meetingCalendarEvents)
      .values({
        meetingId: input.meetingId,
        party: input.party,
        deliveryMode: 'ics',
      })
      .onConflictDoUpdate({
        target: [meetingCalendarEvents.meetingId, meetingCalendarEvents.party],
        // ⚠⚠ See the warning above. Removing this line breaks EVERY write with 42P10.
        targetWhere: isNull(meetingCalendarEvents.deletedAt),
        set: {
          deliveryMode: 'ics',
          connectionId: null,
          calendarId: null,
          vendorEventId: null,
          baloBookingId: null,
          updatedAt: new Date(),
        },
        /**
         * ⚠⚠ THE ORPHAN GUARD. Unqualified in the DO UPDATE `WHERE`, this reads the EXISTING
         * row (Postgres names the target table there; `excluded` would be the proposed one).
         * An already-`ics` row updates — so a retried fallback stays idempotent — and a live
         * `provider_event` row matches nothing, so the statement affects zero rows and the
         * throw below fires. Removing this line restores a SILENT vendor-event orphan.
         */
        setWhere: eq(meetingCalendarEvents.deliveryMode, 'ics'),
      })
      .returning();

    if (result === undefined) {
      // The ONLY way to get here: the insert conflicted and `setWhere` refused the update, i.e.
      // a live `provider_event` row holds this (meeting, party). Loud beats an orphaned event.
      throw new Error(
        'Refused the ICS calendar delivery: a live provider_event row holds this (meeting, party). ' +
          'Delete the vendor event and soft-delete the row first (BAL-475/476).'
      );
    }
    return result;
  },

  /**
   * The live EXPERT-PARTY PROVIDER EVENT for one meeting, if Balo wrote one.
   *
   * ⚠⚠ THE NARROWING IS THE POINT, AND IT REPLACED A WHOLE-MEETING READ. Since BAL-433 a
   * meeting can hold a row per party, and a row can be an ICS FALLBACK carrying no vendor
   * event at all. Three callers turn this read into a `hasVendorEvent` boolean that feeds the
   * availability exclusion, so an ICS row answering "yes" would drop a real busy block and
   * let the expert be DOUBLE-BOOKED — typecheck-clean, every mocked test green. Only a
   * `provider_event` row counts, and only the expert's.
   *
   * `undefined` genuinely means "no live vendor event for this meeting" — never written (no
   * connection, an ICS fallback, or a failed write), or already cancelled. A caller deleting
   * or amending a vendor event must treat it as "nothing to address", never as an error.
   */
  async findLiveExpertProviderEvent(
    meetingId: string
  ): Promise<MeetingCalendarProviderEvent | undefined> {
    const row = await db.query.meetingCalendarEvents.findFirst({
      where: and(
        eq(meetingCalendarEvents.meetingId, meetingId),
        eq(meetingCalendarEvents.party, 'expert'),
        eq(meetingCalendarEvents.deliveryMode, 'provider_event'),
        isNull(meetingCalendarEvents.deletedAt)
      ),
    });

    // Unreachable under the biconditional CHECK. Answering `undefined` rather than throwing
    // is defence in depth: every caller already reads it as "nothing to address".
    if (row === undefined || !isProviderEvent(row)) {
      return undefined;
    }
    return row;
  },

  /**
   * Every live vendor event written through ONE connection, oldest first.
   *
   * The disconnect path's sweep list: when an expert disconnects a provider, the events Balo
   * put in THAT calendar are the ones it may still address (a different connection's events
   * live in a different vendor account and are unreachable with this pointer). An ICS row
   * carries no `connection_id`, so it cannot appear here by construction.
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
   * Soft-delete the live record for one (meeting, PARTY) — the cancel/reschedule path.
   *
   * ⚠ PARTY-SCOPED SINCE BAL-433, AND THAT IS THE WHOLE RENAME. Both callers are expert-side
   * operations (a vendor 404 on the expert's event; the cancel path's delete). A
   * whole-meeting version would soft-delete the CLIENT's row as collateral for a failure that
   * happened on the expert's calendar.
   *
   * ⚠ SOFT DELETE ONLY, and that is what makes rebooking work: the partial unique ignores
   * this row, so the next write for the same (meeting, party) INSERTs beside it instead of
   * failing 23505 against a row the application cannot see
   * (`reference_softdelete_nonpartial_unique_recreate`).
   *
   * ⚠ THIS DOES NOT TOUCH THE VENDOR. Deleting the calendar event at the provider is the
   * caller's separate obligation; this only stops Balo claiming a live event it no longer
   * owns. Marking first and deleting after is the right order — an orphaned vendor event is
   * recoverable via `balo_booking_id`, a lost row is not.
   */
  async softDeleteByMeetingAndParty(
    meetingId: string,
    party: MeetingCalendarEventParty
  ): Promise<void> {
    await db
      .update(meetingCalendarEvents)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(meetingCalendarEvents.meetingId, meetingId),
          eq(meetingCalendarEvents.party, party),
          isNull(meetingCalendarEvents.deletedAt)
        )
      );
  },
};
