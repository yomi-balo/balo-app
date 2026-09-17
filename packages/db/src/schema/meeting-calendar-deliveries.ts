import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { meetingCalendarDeliveryOutcomeEnum } from './enums';
import { meetingCalendarEvents } from './meeting-calendar-events';
import { users } from './users';
import { meetingGuests } from './guests';
import { timestamps, softDelete } from './helpers';

/**
 * The transport a calendar invite went out on. `email` only in V1 (nodemailer over the Brevo
 * SMTP relay). A text column + CHECK rather than a pgEnum, so widening it is a CHECK relax
 * with no `ALTER TYPE … ADD VALUE` same-transaction hazard (0076's reasoning).
 */
export type MeetingCalendarDeliveryChannel = 'email';

/**
 * The RFC 5546 iTIP method on the wire. `REQUEST` only in BAL-475; BAL-476 relaxes the CHECK
 * to add `CANCEL` (again a CHECK relax, not an enum migration).
 */
export type MeetingCalendarDeliveryMethod = 'REQUEST';

/**
 * meeting_calendar_deliveries (BAL-475, decision O4) — ONE ROW PER CALENDAR-INVITE SEND:
 * calendar event × recipient × SEQUENCE × method.
 *
 * ── WHY A LEDGER BESIDE `meeting_calendar_events` ──────────────────────────────────────
 * The `(meeting, party)` row + `delivery_mode` does NOT supersede this table: it has no
 * per-RECIPIENT grain (one party row fans out to the booker or delivering expert AND that
 * side's admitted guests), no SEQUENCE history and no outcome. What this table makes
 * ENFORCEABLE is "no duplicate ICS at the same SEQUENCE for the same recipient": the two
 * partial uniques below plus `meetingCalendarDeliveriesRepository.claimSend`'s protocol.
 *
 * ── THE CLAIM PROTOCOL, IN ONE PARAGRAPH ───────────────────────────────────────────────
 * A delivery job CLAIMS the row (`outcome = 'pending'`, `claim_token` = its BullMQ job id)
 * immediately before sending, then marks it `sent` or `failed`. The SAME job (a retry or a
 * stall re-run keeps its job id) may always re-claim; a DIFFERENT job may take over only a
 * `failed` row or a `pending` row whose lease (`last_attempted_at`) has lapsed; a `sent` row
 * is never re-claimed. See the repository for the exact statement.
 *
 * ⚠ RECIPIENT IS EXACTLY ONE OF A USER OR A GUEST (`…_recipient_exactly_one`), and that is
 * why there are TWO partial uniques rather than one over both nullable columns: Postgres
 * treats NULLs as distinct, so a single unique over `(event, user, guest, sequence, method)`
 * would never conflict.
 *
 * ⚠ F11 (fix round 1, R10) — `calendar_event_id` LEADS BOTH UNIQUES, BUT THAT DOES NOT SERVE
 * THE FK. The previous claim here was wrong: both uniques are PARTIAL
 * (`recipient_…_id IS NOT NULL AND deleted_at IS NULL`), and Postgres will not use a partial
 * index to plan a query whose WHERE clause does not repeat that predicate — the FK's cascade
 * delete (`DELETE … WHERE calendar_event_id = $1`, no such predicate) cannot select either
 * one. `calendarEventIdx` below is the FK's own, non-partial index, matching the drizzle
 * skill's "every FK column gets an index" rule.
 *
 * ⚠ BOTH UNIQUES ARE PARTIAL ON `deleted_at IS NULL`
 * (`reference_softdelete_nonpartial_unique_recreate`), and their predicates contain NO
 * literal — only `IS [NOT] NULL` — so an ON CONFLICT arbiter restating them can carry no
 * bind parameter (`reference_pg_partial_index_arbiter_param_42p10`).
 *
 * ⚠ NO ADDRESS IS STORED. The recipient is an id; the address is resolved at send time by
 * the email channel and never persisted here, and `failure_reason` holds a class/code only
 * (SMTP replies can echo the address).
 *
 * ⚠ NO RLS, matching every other table in this package except `stripe_webhook_events`
 * (see `schema/meeting-calendar-events.ts`). Read and written only through
 * `meetingCalendarDeliveriesRepository` on the admin client.
 */
export const meetingCalendarDeliveries = pgTable(
  'meeting_calendar_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The (meeting, party) calendar row whose `uid` this send carried. `cascade`: the ledger
     * describes sends of that series; with the series row hard-deleted (seed truncation
     * today) it describes nothing.
     */
    calendarEventId: uuid('calendar_event_id')
      .notNull()
      .references(() => meetingCalendarEvents.id, { onDelete: 'cascade' }),

    /**
     * A MEMBER recipient — the booker or the delivering expert. Matches
     * `notification_log.recipient_id`. `cascade`: a hard-deleted user has no inbox to dedupe.
     */
    recipientUserId: uuid('recipient_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),

    /** A GUEST recipient (`meeting_guests.id`). `cascade`, for the same reason. */
    recipientGuestId: uuid('recipient_guest_id').references(() => meetingGuests.id, {
      onDelete: 'cascade',
    }),

    /** See {@link MeetingCalendarDeliveryChannel}. CHECK-narrowed below. */
    channel: text('channel').$type<MeetingCalendarDeliveryChannel>().notNull(),

    /** See {@link MeetingCalendarDeliveryMethod}. CHECK-narrowed below. */
    method: text('method').$type<MeetingCalendarDeliveryMethod>().notNull(),

    /**
     * The SEQUENCE actually put in the ICS — read from `meeting_calendar_events.sequence` at
     * send time. Part of the dedupe key: a reschedule bumps it, so the re-send is a NEW row.
     */
    sequence: integer('sequence').notNull(),

    /** No default: the only writer (`claimSend`) always states it. */
    outcome: meetingCalendarDeliveryOutcomeEnum('outcome').notNull(),

    /** The BullMQ job id that holds (or last held) the claim. */
    claimToken: text('claim_token').notNull(),

    /** 1 on the first claim, incremented on every re-claim. */
    attemptCount: integer('attempt_count').notNull(),

    /** Set to `now()` on every claim — the lease clock for a `pending` takeover. */
    lastAttemptedAt: timestamp('last_attempted_at', { withTimezone: true }).notNull(),

    /** When the transport accepted it. Paired with `outcome = 'sent'` by CHECK. */
    sentAt: timestamp('sent_at', { withTimezone: true }),

    /**
     * Why the transport rejected it — CLASS / CODE ONLY (e.g. `Error:EAUTH:535`), never a
     * transport message. Paired with `outcome = 'failed'` by CHECK.
     */
    failureReason: text('failure_reason'),

    /** The transport's message id (nodemailer `info.messageId`), for provider support traces. */
    providerMessageId: text('provider_message_id'),

    ...timestamps,
    ...softDelete,
  },
  (table) => ({
    /** No duplicate send to a MEMBER at the same SEQUENCE and method. See the file docblock. */
    userSendUq: uniqueIndex('meeting_calendar_delivery_user_send_uq')
      .on(table.calendarEventId, table.recipientUserId, table.sequence, table.method)
      .where(sql`${table.recipientUserId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    /** No duplicate send to a GUEST at the same SEQUENCE and method. */
    guestSendUq: uniqueIndex('meeting_calendar_delivery_guest_send_uq')
      .on(table.calendarEventId, table.recipientGuestId, table.sequence, table.method)
      .where(sql`${table.recipientGuestId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    /**
     * F11 (fix round 1, R10) — serves the `calendar_event_id` FK's cascade delete. Neither
     * partial unique above can serve it (see the file docblock); this is non-partial,
     * unconditionally usable by the FK's own query shape.
     */
    calendarEventIdx: index('meeting_calendar_delivery_calendar_event_idx').on(
      table.calendarEventId
    ),
    /** Serves the FK (the uniques lead with `calendar_event_id`, not the recipient). */
    recipientUserIdx: index('meeting_calendar_delivery_recipient_user_idx').on(
      table.recipientUserId
    ),
    recipientGuestIdx: index('meeting_calendar_delivery_recipient_guest_idx').on(
      table.recipientGuestId
    ),

    /** Exactly one recipient. `IS NULL` is never NULL, so this cannot pass by 3VL. */
    recipientExactlyOne: check(
      'meeting_calendar_delivery_recipient_exactly_one',
      sql`(${table.recipientUserId} IS NULL) <> (${table.recipientGuestId} IS NULL)`
    ),
    channelKnown: check(
      'meeting_calendar_delivery_channel_known',
      sql`${table.channel} IN ('email')`
    ),
    methodKnown: check(
      'meeting_calendar_delivery_method_known',
      sql`${table.method} IN ('REQUEST')`
    ),
    sequenceNonNegative: check(
      'meeting_calendar_delivery_sequence_non_negative',
      sql`${table.sequence} >= 0`
    ),
    attemptCountPositive: check(
      'meeting_calendar_delivery_attempt_count_positive',
      sql`${table.attemptCount} >= 1`
    ),
    /**
     * `sent` ⟺ `sent_at` present. Against a FUTURE label the equality form is fail-CLOSED
     * here: `false = (sent_at IS NOT NULL)` demands `sent_at` be NULL.
     */
    sentAtPaired: check(
      'meeting_calendar_delivery_sent_at_paired',
      sql`(${table.outcome} = 'sent') = (${table.sentAt} IS NOT NULL)`
    ),
    /** `failed` ⟺ `failure_reason` present. Same fail-closed shape. */
    failureReasonPaired: check(
      'meeting_calendar_delivery_failure_reason_paired',
      sql`(${table.outcome} = 'failed') = (${table.failureReason} IS NOT NULL)`
    ),
  })
);

// ── Relations ───────────────────────────────────────────────────

/**
 * ⚠ ONLY `calendarEvent`. NO `user` / `guest` relation, deliberately: a relational `with:`
 * would hydrate `users.email` / `meeting_guests.email` into callers
 * (`reference_drizzle_with_hydration_leaks_secrets`). The repository uses the core select
 * builder.
 */
export const meetingCalendarDeliveriesRelations = relations(
  meetingCalendarDeliveries,
  ({ one }) => ({
    calendarEvent: one(meetingCalendarEvents, {
      fields: [meetingCalendarDeliveries.calendarEventId],
      references: [meetingCalendarEvents.id],
    }),
  })
);

// ── Type exports ────────────────────────────────────────────────

export type MeetingCalendarDelivery = typeof meetingCalendarDeliveries.$inferSelect;
export type NewMeetingCalendarDelivery = typeof meetingCalendarDeliveries.$inferInsert;

/** One send's state (schema-derived — single source of truth). */
export type MeetingCalendarDeliveryOutcome =
  (typeof meetingCalendarDeliveryOutcomeEnum.enumValues)[number];
