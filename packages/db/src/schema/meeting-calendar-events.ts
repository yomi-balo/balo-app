import { pgTable, uuid, text, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { meetings } from './meetings';
import { calendarConnections } from './calendar';
import { timestamps, softDelete } from './helpers';

/**
 * meeting_calendar_events (BAL-396 §5) — WHERE THE VENDOR'S CALENDAR EVENT ID LIVES.
 *
 * Writing a consultation into the expert's own calendar produces one identifier Balo does
 * not own and cannot re-derive: the provider's event id. Before this table there was NO
 * column for it anywhere (verified: zero hits for `calendar_event_id` /
 * `external_event_id` / `cronofy_event_id` / `baloBookingId` across `packages/` and
 * `apps/api/src`), and both obvious homes are closed:
 *
 *   · **`meetings` is FORBIDDEN.** `invariants/meetings-no-context-column.test.ts` asserts
 *     that table declares no column name ending in `_id`, exactly ONE uuid column, and NO
 *     foreign key at all. A `calendar_event_id` column and a `connection_id` FK each fail
 *     that invariant — which exists precisely so the meetings primitive stays a primitive.
 *   · **`consultations` is WRONG.** It is a derived read model with a single writer
 *     (`repositories/_shared/consultation-projection.ts`, called only from inside
 *     `meetingsRepository` / `meetingContextsRepository` transactions) and its `create()`
 *     was deliberately deleted. A vendor event id is not derivable from a meeting, so it
 *     does not belong in a projection of one.
 *
 * ⚠ NO RLS, matching every other table in this package except `stripe_webhook_events`
 * (see `schema/calendar.ts`). Balo authenticates at the application layer (WorkOS) and
 * reads this table only through `meetingCalendarEventsRepository` on the admin client.
 */
export const meetingCalendarEvents = pgTable(
  'meeting_calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The Balo meeting the vendor event mirrors. `cascade`: if the meeting row is ever hard
     * deleted (seed truncation today), a record pointing at a vendor event for a meeting
     * that no longer exists is worse than no record.
     */
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),

    /**
     * The connection the event was written THROUGH — the only way to know which End User
     * Account (and therefore which vendor account) can delete it again. `cascade`: a
     * hard-deleted connection can no longer address the vendor event at all.
     */
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => calendarConnections.id, { onDelete: 'cascade' }),

    /**
     * The calendar written to AT WRITE TIME — never re-read from
     * `calendar_connections.target_calendar_id`, which the expert may change afterwards.
     * Deleting or patching the event needs the ORIGINAL calendar, not the current target.
     */
    calendarId: text('calendar_id').notNull(),

    /**
     * ⚠⚠ THE VENDOR-RETURNED ID, NEVER A DERIVED ONE (apiroc skill §M1). Microsoft answers
     * HTTP 200 to a caller-supplied `id` and silently substitutes a Graph id — so an
     * idempotency design keyed on a derived id passes every Google test and then
     * double-books Microsoft experts in production only. Idempotency here is keyed on
     * BALO'S OWN `meeting_id` (the partial unique below); this column is the answer we were
     * given, stored verbatim.
     */
    vendorEventId: text('vendor_event_id').notNull(),

    /**
     * The value written to the event's `privateExtendedProperties.baloBookingId`. STORED,
     * not re-derived, so a reconcile-by-tag query asks the vendor for exactly what was
     * written rather than for what today's code would write.
     */
    baloBookingId: text('balo_booking_id').notNull(),

    ...timestamps,
    ...softDelete,
  },
  (table) => ({
    /**
     * ONE live vendor event per meeting — the idempotency key for the event write.
     *
     * ⚠ PARTIAL ON `deleted_at IS NULL`, and that is load-bearing: a cancelled-then-
     * rebooked meeting must be able to write a SECOND calendar event. A non-partial unique
     * would fail 23505 against a soft-deleted row the application cannot see (memory
     * `reference_softdelete_nonpartial_unique_recreate`) — the same rule as
     * `consultations_meeting_uq` and `cal_conn_expert_provider_idx`, and the same reason
     * `meetingCalendarEventsRepository.record` must restate this predicate as `targetWhere`
     * or every upsert raises 42P10 at plan time.
     */
    meetingIdx: uniqueIndex('meeting_calendar_event_meeting_uq')
      .on(table.meetingId)
      .where(sql`${table.deletedAt} IS NULL`),
    /** Serves the per-connection sweep (`listLiveByConnectionId`) and the FK. */
    connectionIdx: index('meeting_calendar_event_connection_idx').on(table.connectionId),
    /** Serves reconcile-by-tag: "which meeting does this tagged vendor event belong to?". */
    bookingTagIdx: index('meeting_calendar_event_tag_idx').on(table.baloBookingId),
  })
);

// ── Relations ───────────────────────────────────────────────────

export const meetingCalendarEventsRelations = relations(meetingCalendarEvents, ({ one }) => ({
  meeting: one(meetings, {
    fields: [meetingCalendarEvents.meetingId],
    references: [meetings.id],
  }),
  connection: one(calendarConnections, {
    fields: [meetingCalendarEvents.connectionId],
    references: [calendarConnections.id],
  }),
}));

// ── Type exports ────────────────────────────────────────────────

export type MeetingCalendarEvent = typeof meetingCalendarEvents.$inferSelect;
export type NewMeetingCalendarEvent = typeof meetingCalendarEvents.$inferInsert;
