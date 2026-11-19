import { pgTable, uuid, timestamp, boolean, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import {
  meetingRingStatusEnum,
  meetingRingPlacementEnum,
  meetingRingReachEnum,
  meetingRingSideEnum,
} from './enums';
import { meetings } from './meetings';
import { engagements } from './engagements';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * meeting_rings (BAL-649) — ONE ROW PER CALL NOW RING: one party ringing the other on a case,
 * right now, instead of booking a time.
 *
 * A ring sits on exactly one meeting:
 *   · `placement = 'new_meeting'` — the ring created a fresh `case` meeting starting now. That
 *     ring row IS the meeting's "started by Call now" marker. `meetings` carries no column for
 *     it, deliberately: a column there would be declared by the next web build, and every
 *     full-row `meetings` read would fail `42703` if Vercel served that build before Railway's
 *     migrate committed (and `invariants/meetings-no-context-column.test.ts` holds that table
 *     to zero outbound FKs). The derived fact is `origin = 'call_now'` iff the meeting has a
 *     `new_meeting` ring.
 *   · `placement = 'in_place'` — the ring rides a same-day booked meeting. An unanswered ring
 *     leaves that booking exactly as it was; a connected one moves its start to the connect
 *     instant.
 *
 * ⚠ `status` IS CHANGED ONLY BY `meetingRingsRepository`'s COMPARE-AND-SETs, each FROM
 * `'ringing'`. Exactly one of connect / expiry / decline / stop wins a race on one ring, and
 * Postgres — never Redis — is the record of when a ring ends (`expires_at`).
 *
 * `caller_side` is server-derived from the capability arm that authorized the caller, never
 * from request input. `callee_user_id` is the callee as resolved when the ring started, so a
 * later membership change cannot re-point a ring that is already sounding.
 *
 * NO `meetings` RELATION BACK TO THIS TABLE: the FK and the relation point from the ring to
 * the meeting only, matching `consultations`.
 *
 * NO RLS (matching `meetings` / `meeting_presence` and the credit precedents): access is gated
 * at the application layer — a ring is read only by its caller or callee, by identity match,
 * through the API.
 *
 * ADR-1030: every state change writes a `meeting.ring_started` / `meeting.ring_ended`
 * `audit_events` row in the same transaction, so `caller_user_id` (the floor) and the audit row
 * (the ceiling) both name the person. The actor FKs are ON DELETE RESTRICT, the attribution
 * convention.
 */
export const meetingRings = pgTable(
  'meeting_rings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    // The case. Carries the one-ringing-ring-per-case uniqueness below.
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),

    callerUserId: uuid('caller_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    calleeUserId: uuid('callee_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    callerSide: meetingRingSideEnum('caller_side').notNull(),
    placement: meetingRingPlacementEnum('placement').notNull(),
    status: meetingRingStatusEnum('status').notNull().default('ringing'),
    reachedBy: meetingRingReachEnum('reached_by').notNull().default('app'),

    // When the ring window closes. A `ringing` row past this instant is overdue: the expiry job
    // or the lifecycle sweep's backstop ends it as `unanswered`.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // When the ring left `ringing` (connected, unanswered, declined or stopped).
    endedAt: timestamp('ended_at', { withTimezone: true }),

    // BAL-651 — ANALYTICS CORRELATION ONLY, never an authorization input and never a lookup key
    // (hence no index, no FK). Both are written once, by the start, and read back only to emit
    // `call_now_ring_ended`, which often fires from the expiry job long after the start request,
    // so the row is the only carrier. Both are NULL on a ring started before they existed.
    //   · `attempt_id`: the web client's per-tap id, joining the client funnel to the outcome.
    //     NULL also when the caller sent none or an invalid one: analytics never blocks a call.
    //   · `callee_online_at_start`: the presence gate's answer at the start, UNMASKED. It is
    //     server analytics only; a ring read must never hand it to an expert caller as-is.
    attemptId: uuid('attempt_id'),
    calleeOnlineAtStart: boolean('callee_online_at_start'),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // At most ONE ringing ring per case. Two simultaneous starts on one case raise 23505 here,
    // which the repository maps to `MeetingRingAlreadyLiveError` (and on the `new_meeting` path
    // the whole meeting creation rolls back with it). Partial on `deleted_at IS NULL` so a
    // soft-deleted row never occupies the slot. Naming `'ringing'` is safe: the type is created
    // by a standalone `CREATE TYPE` in the same migration.
    uniqueIndex('meeting_ring_one_ringing_per_engagement_idx')
      .on(t.engagementId)
      .where(sql`${t.status} = 'ringing' AND ${t.deletedAt} IS NULL`),
    // Every ring on a meeting (the lifecycle facts and the in-place reads).
    index('meeting_ring_meeting_idx').on(t.meetingId),
    // The overdue-ring scan: `ringing` rows ordered by `expires_at`.
    index('meeting_ring_ringing_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'ringing' AND ${t.deletedAt} IS NULL`),
    // FK indexes: the caller's and callee's identity reads, and the RESTRICT delete-time scans.
    index('meeting_ring_caller_idx').on(t.callerUserId),
    index('meeting_ring_callee_idx').on(t.calleeUserId),
    // A ringing ring has not ended; every other status has. Biconditional, so `ended_at` can
    // never be stamped without a terminal status or left NULL beside one. Both operands are
    // total (`=` on a NOT NULL column, `IS NULL`), so no three-valued-logic hole.
    check(
      'meeting_ring_ended_iff_not_ringing',
      sql`(${t.status} = 'ringing') = (${t.endedAt} IS NULL)`
    ),
    check('meeting_ring_expires_after_created', sql`${t.expiresAt} > ${t.createdAt}`),
    check('meeting_ring_caller_not_callee', sql`${t.callerUserId} <> ${t.calleeUserId}`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const meetingRingsRelations = relations(meetingRings, ({ one }) => ({
  meeting: one(meetings, {
    fields: [meetingRings.meetingId],
    references: [meetings.id],
  }),
  engagement: one(engagements, {
    fields: [meetingRings.engagementId],
    references: [engagements.id],
  }),
  caller: one(users, {
    fields: [meetingRings.callerUserId],
    references: [users.id],
  }),
  callee: one(users, {
    fields: [meetingRings.calleeUserId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type MeetingRing = typeof meetingRings.$inferSelect;
export type NewMeetingRing = typeof meetingRings.$inferInsert;

/** A ring's lifecycle status (schema-derived — single source of truth). */
export type MeetingRingStatus = (typeof meetingRingStatusEnum.enumValues)[number];
/** Where a ring sits (schema-derived). */
export type MeetingRingPlacement = (typeof meetingRingPlacementEnum.enumValues)[number];
/** How the callee was reached (schema-derived). */
export type MeetingRingReach = (typeof meetingRingReachEnum.enumValues)[number];
/** Which side placed the ring (schema-derived). */
export type MeetingRingSide = (typeof meetingRingSideEnum.enumValues)[number];
