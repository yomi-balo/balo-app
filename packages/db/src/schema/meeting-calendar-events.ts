import { pgTable, uuid, text, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { meetingCalendarDeliveryModeEnum, meetingParticipantPartyEnum } from './enums';
import { meetings } from './meetings';
import { calendarConnections } from './calendar';
import { timestamps, softDelete } from './helpers';

/**
 * meeting_calendar_events (BAL-396 §5, widened by BAL-433) — WHAT EACH PARTY'S CALENDAR
 * ENTRY FOR ONE MEETING BECAME.
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
 * ── BAL-433 (ADR-1044 amendment 2026-08-25, RULING 1): THE GRAIN IS (MEETING, PARTY) ───
 * A party gets a provider write **OR** an ICS, **NEVER BOTH**. That rule is a CONSTRAINT
 * here, not an application convention: there is exactly ONE live row per
 * `(meeting_id, party)`, and `delivery_mode` says which of the two answers it holds. A
 * second table (provider writes in A, ICS deliveries in B) would make "never both"
 * unrepresentable to a constraint — the first concurrent retry writing one of each would be
 * undetectable.
 *
 * The four PROVIDER columns (`connection_id`, `calendar_id`, `vendor_event_id`,
 * `balo_booking_id`) are therefore NULLABLE, tied to `delivery_mode` by the biconditional
 * CHECK `meeting_calendar_event_delivery_payload` — so an `ics` row cannot carry a stale
 * vendor id, and a `provider_event` row cannot claim an event it cannot address.
 *
 * ⚠ SLICE 1 RECORDS THE ICS CONDITION AND SENDS NOTHING. Building and delivering the ICS is
 * BAL-475; cancellation (`METHOD:CANCEL`) is BAL-476. There is also NO VENDOR PATH FOR THE
 * CLIENT PARTY today — `calendar_connections` is keyed on `expert_profile_id` and no
 * client-side connection model exists anywhere in the repo — so NO WRITER PRODUCES a
 * client-party `provider_event` row. ⚠ THAT IS A PROPERTY OF THE WRITERS, NOT A CONSTRAINT:
 * nothing in this schema forbids one (`recordProviderEvent` takes a typed `party`, and the
 * integration suite deliberately writes such a row to isolate the party filter). Do not read
 * "provider_event ⇒ expert" as an invariant a query may rely on; scope the query.
 *
 * ⚠ `id` IS THE PER-WRITE KEY. It is stable across retries of the same delivery (the
 * `DO UPDATE` arm keeps it) and FRESH after a soft-delete + rebook (the partial unique
 * INSERTs beside the old row). Any future `jobId` / `correlationId` / ICS `UID` seeds off
 * THIS, never off `meeting_id` — a key derived from a target state or a window reproduces
 * the A→B→C→B silent drop this repo has been bitten by twice
 * (`reference_bullmq_jobid_must_be_per_write_not_per_state`).
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
     * The Balo meeting the calendar entry mirrors. `cascade`: if the meeting row is ever hard
     * deleted (seed truncation today), a record pointing at a vendor event for a meeting
     * that no longer exists is worse than no record.
     */
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),

    /**
     * WHOSE calendar entry this row describes (BAL-433). Reuses the THREE-label
     * `meeting_participant_party` enum narrowed by the CHECK
     * `meeting_calendar_event_party_two_sided` to `client | expert` — the
     * `meeting_guests.party` / `meeting_files.party` ruling verbatim. A bespoke two-label
     * enum would need `ALTER TYPE … ADD VALUE` the first time a third party needs a row, and
     * that migration inherits the one-transaction hazard
     * (`reference_enum_default_same_tx_migration_hazard`); RELAXING a CHECK has no such
     * hazard.
     *
     * ⚠ NEVER A REQUEST FIELD. The writer derives it structurally: a provider event is always
     * the EXPERT's, because `endUserAccountId` comes off a `calendar_connections` row and
     * that table is keyed on `expert_profile_id`.
     */
    party: meetingParticipantPartyEnum('party').notNull(),

    /**
     * HOW this party's entry was delivered — the ADR-1044 Ruling 1 discriminator. See the
     * enum's own docblock, and the biconditional CHECK below which is what makes it honest.
     */
    deliveryMode: meetingCalendarDeliveryModeEnum('delivery_mode').notNull(),

    /**
     * The connection the event was written THROUGH — the only way to know which End User
     * Account (and therefore which vendor account) can delete it again. `cascade`: a
     * hard-deleted connection can no longer address the vendor event at all.
     *
     * ⚠ NULLABLE since BAL-433: an `ics` row was never written through a connection.
     */
    connectionId: uuid('connection_id').references(() => calendarConnections.id, {
      onDelete: 'cascade',
    }),

    /**
     * The calendar written to AT WRITE TIME — never re-read from
     * `calendar_connections.target_calendar_id`, which the expert may change afterwards.
     * Deleting or patching the event needs the ORIGINAL calendar, not the current target.
     *
     * ⚠ NULLABLE since BAL-433 — an `ics` row addresses no calendar.
     */
    calendarId: text('calendar_id'),

    /**
     * ⚠⚠ THE VENDOR-RETURNED ID, NEVER A DERIVED ONE (apiroc skill §M1). Microsoft answers
     * HTTP 200 to a caller-supplied `id` and silently substitutes a Graph id — so an
     * idempotency design keyed on a derived id passes every Google test and then
     * double-books Microsoft experts in production only. Idempotency here is keyed on
     * BALO'S OWN `(meeting_id, party)` (the partial unique below); this column is the answer
     * we were given, stored verbatim.
     *
     * ⚠ NULLABLE since BAL-433 — an `ics` row names no vendor event.
     */
    vendorEventId: text('vendor_event_id'),

    /**
     * The value written to the event's `privateExtendedProperties.baloBookingId`. STORED,
     * not re-derived, so a reconcile-by-tag query asks the vendor for exactly what was
     * written rather than for what today's code would write.
     *
     * ⚠ NULLABLE since BAL-433 — it IS the vendor tag, so an `ics` row must not carry one.
     */
    baloBookingId: text('balo_booking_id'),

    ...timestamps,
    ...softDelete,
  },
  (table) => ({
    /**
     * ONE live calendar entry per (meeting, PARTY) — the idempotency key for the write, and
     * the structural form of ADR-1044's Ruling 1: a party gets a provider write OR an ICS,
     * NEVER BOTH, because there is only one live row to hold either answer.
     *
     * ⚠ PARTIAL ON `deleted_at IS NULL`, and that is load-bearing (unchanged from BAL-396): a
     * cancelled-then-rebooked meeting must be able to write a SECOND entry. A non-partial
     * unique would fail 23505 against a soft-deleted row the application cannot see
     * (`reference_softdelete_nonpartial_unique_recreate`) — and it is the same reason BOTH
     * writers must restate this predicate as `targetWhere` or every upsert raises 42P10 at
     * PLAN time.
     */
    meetingPartyIdx: uniqueIndex('meeting_calendar_event_meeting_party_uq')
      .on(table.meetingId, table.party)
      .where(sql`${table.deletedAt} IS NULL`),
    /** Serves the per-connection sweep (`listLiveByConnectionId`) and the FK. */
    connectionIdx: index('meeting_calendar_event_connection_idx').on(table.connectionId),
    /** Serves reconcile-by-tag: "which meeting does this tagged vendor event belong to?". */
    bookingTagIdx: index('meeting_calendar_event_tag_idx').on(table.baloBookingId),

    /**
     * Two-sided, by CHECK — see the `party` column note. THREE-VALUED-LOGIC SAFE: `party` is
     * NOT NULL and is compared to literals, so this can never "pass by being unknown".
     */
    partyTwoSided: check(
      'meeting_calendar_event_party_two_sided',
      sql`${table.party} IN ('client','expert')`
    ),

    /**
     * ⚠⚠ THE PAYLOAD MUST MATCH THE MODE — ONE ARM PER LABEL, ENUMERATED, NOT A BICONDITIONAL.
     * `provider_event` ⇒ all four provider columns present; `ics` ⇒ all four absent. Any row
     * that matches NEITHER arm is rejected. It is what stops an `ics` row carrying a stale
     * vendor id after a mode transition, and what stops a `provider_event` row claiming an
     * event it cannot address. NOT-NULL-safe: `delivery_mode` is NOT NULL and compared to a
     * literal, and every other operand is an `IS [NOT] NULL` predicate, which is never NULL —
     * so this can never pass by three-valued logic.
     *
     * ⚠⚠ THE DISJUNCTIVE FORM IS FAIL-CLOSED AGAINST A THIRD LABEL, AND THAT IS WHY IT IS NOT
     * WRITTEN AS `(mode = 'provider_event') = (all present) AND (mode = 'ics') = (all absent)`.
     * The equality form is EQUIVALENT for the two labels shipped today and WRONG the moment a
     * third is added: for a label that is neither, both conjuncts read `false = false` on a
     * PARTIAL payload and the row is ACCEPTED — reopening the exact hole this constraint
     * exists to close (an `ics`-shaped row carrying a stale `vendor_event_id`). The enum is
     * append-only and adding a label is already a deliberate migration; this makes forgetting
     * to widen the CHECK a 23514 rather than a silent hole. The integration suite proves both
     * directions plus the partial-payload case.
     */
    deliveryPayload: check(
      'meeting_calendar_event_delivery_payload',
      sql`(${table.deliveryMode} = 'provider_event' AND ${table.connectionId} IS NOT NULL AND ${table.calendarId} IS NOT NULL AND ${table.vendorEventId} IS NOT NULL AND ${table.baloBookingId} IS NOT NULL) OR (${table.deliveryMode} = 'ics' AND ${table.connectionId} IS NULL AND ${table.calendarId} IS NULL AND ${table.vendorEventId} IS NULL AND ${table.baloBookingId} IS NULL)`
    ),
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

/** How one party's calendar entry was delivered (schema-derived — single source of truth). */
export type MeetingCalendarDeliveryMode =
  (typeof meetingCalendarDeliveryModeEnum.enumValues)[number];
