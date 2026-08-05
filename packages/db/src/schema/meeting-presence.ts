import { pgTable, uuid, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { meetingParticipantPartyEnum } from './enums';
import { meetings } from './meetings';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * meeting_presence (BAL-418 / ADR-1045 §6) — ONE ROW PER PRESENCE INTERVAL (a join→leave
 * pair), never a per-participant aggregate. This is what makes BAL-134's TWO CLOCKS
 * computable and BAL-412's settlement readable:
 *
 *   expertPresentMs = last expert PRESENCE   − FIRST expert join                 (gap-inclusive)
 *   billableMs      = last instant both sides present − FIRST such instant       (gap-inclusive)
 *
 * "last expert PRESENCE", never "last expert leave": an interval with `left_at IS NULL` has
 * no leave, and its end is whatever instant the clock is measured against. That is exactly
 * the dropped-leave-webhook case the over-bill hazard on `resolveClockCeiling` is about, so
 * the wording is load-bearing — an expert whose only interval is still open, measured at
 * minute 45, reports `expertPresentMs = 45 min`, sourced from `now`.
 *
 * WHY PER-INTERVAL. A single mutable row per participant (`joined_at`/`left_at`) has no
 * non-lossy answer to a rejoin: overwrite `joined_at` and the first interval is lost;
 * insert a second row and you have the interval model anyway, without having designed for
 * it. And the BILLABLE clock is an INTERSECTION OVER TIME of two participant sets — not
 * computable at all from per-participant totals.
 *
 * WHY THE CLOCKS ARE SPANS, NOT SUMS. A drop+rejoin adds a second interval row but does
 * NOT move the first-join anchor and does NOT restart the timer — the span is unchanged
 * and the gap sits inside it. That is BAL-134's "rejoins must not fragment the duration or
 * restart the billable timer". `SUM(left_at − joined_at)` would silently SHORTEN a call
 * for every network blip, i.e. under-bill.
 *
 * ⚠ THE SAME CHOICE CUTS BOTH WAYS. Gap-inclusive bills a gap of ANY size: on a 60-minute
 * call with the expert present throughout, a client present 2→4 min and again 58→60 min
 * yields `billableMs = 58 min` — the SPAN 2→60 — NOT the 4 min a sum-of-intervals would
 * give. (The anchor is the FIRST both-present instant, not the call start: had that client
 * instead joined at minute 0, the span would be the full 60.) That IS the intended
 * semantics — the expert held the slot for the whole hour, and a rule that pauses billing
 * during a gap is the rule a party could exploit by dropping — but it is a real exposure at
 * the long end. The POLICY CAP is **BAL-412's** (settlement, which already carries
 * `effectiveCeilingMinor`), with **BAL-134** clamping presence to the meeting window on the
 * write side. Neither this table nor the pure clock caps anything: the only DB CHECK here
 * is `left_at >= joined_at`. Both numbers are PINNED by tests in
 * `packages/shared/src/meetings/index.test.ts`.
 *
 * The clock computation itself is PURE and lives in `@balo/shared/meetings`
 * (`computeMeetingClocks`), NOT in `@balo/db`, so BAL-403's in-session client panel can
 * render it without value-importing `@balo/db` (memory
 * `reference_balo_db_client_bundle_footgun`). This table + `meetingPresenceRepository` own
 * the storage and the read; BAL-134 owns the WRITE logic.
 *
 * NO RLS (matching `meetings` / `meeting_contexts` and the credit precedents).
 *
 * ADR-1030 SYSTEM-ACTOR ATTRIBUTION EXEMPTION (owner-ruled; the same ruling as BAL-387's
 * transcript pipeline and BAL-420's `auto_inactive` case close). Presence is a MACHINE
 * OBSERVATION — BAL-134's Daily `participant-joined`/`participant-left` webhooks — so there
 * is no human actor to name, and the write is exempt from durable ATTRIBUTION because all
 * three prongs hold: (1) it changes no party's authority or capability (a presence row
 * grants nothing; host rights are ADR-1046/BAL-413's `hasEngagementCapability`); (2) NO
 * MONEY MOVES OR ACCRUES HERE — this table is a billing INPUT, not a money action, exactly
 * as `credit_holds` is ("a hold moves no money; ADR-1030 audit is for money actions"), and
 * the money event it feeds is BAL-412's settlement, which carries its own ADR-1030 floor
 * (`credit_ledger.member_id`) and ceiling (`credit_wallet.consumed` / `.settled`); (3) it
 * writes no party-visible domain row directly — presence reaches a party only THROUGH that
 * settled amount, and the obligation to audit it is the settlement's, not this table's.
 *
 * ⚠ `user_id` IS THE SUBJECT, NOT THE ACTOR. It records who was OBSERVED in the room, never
 * who performed a write, so ADR-1030's "actor FKs are ON DELETE restrict" convention does
 * not govern it — and `set null` + `party` is strictly BETTER for the billing record than
 * restrict would be: restrict would BLOCK a user hard-delete, `set null` PRESERVES the
 * interval and its side. For the same reason NO `created_by_user_id` is added: the only
 * honest value a webhook could write is NULL forever, and an attribution column with no
 * writer is a worse lie than its absence.
 *
 * The exemption is from ATTRIBUTION, NOT from evidence. The interval rows ARE the durable,
 * dispute-grade billing record — append-then-close, soft-delete only, surviving actor
 * deletion — which meets ADR-1030's purpose structurally rather than with an `audit_events`
 * row per webhook. Per-join/leave rows would be machine telemetry, which ADR-1030 routes to
 * Pino/Axiom and explicitly keeps out of Postgres.
 */
export const meetingPresence = pgTable(
  'meeting_presence',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),

    // NULL for a guest (`meeting_guests` carries no user until conversion). SET NULL, not
    // restrict: `admin-dev/_actions/delete-user.ts` HARD-deletes users, and a presence
    // interval is a BILLING input (BAL-412) that must survive the actor row. `party`
    // preserves the side even after the user is gone.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    party: meetingParticipantPartyEnum('party').notNull(),

    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull(),
    // NULL = still present.
    leftAt: timestamp('left_at', { withTimezone: true }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // The clock computation scan: all live intervals for a meeting, by side, in time order.
    index('meeting_presence_meeting_party_idx')
      .on(t.meetingId, t.party, t.joinedAt)
      .where(sql`${t.deletedAt} IS NULL`),
    // "Who is in the room right now" + the open-interval resume anchor for BAL-134.
    index('meeting_presence_open_idx')
      .on(t.meetingId)
      .where(sql`${t.leftAt} IS NULL AND ${t.deletedAt} IS NULL`),
    // At most ONE open interval per authenticated participant — a duplicate join webhook
    // cannot create a second open interval that would double-count the clocks.
    // ⚠ GUEST GAP: `user_id` is NULL for a guest and NULLs are DISTINCT in a unique index,
    // so a guest is NOT covered. Accepted here (guests carry no presence identity until
    // BAL-408); BAL-134/BAL-408 must add the guest-keyed equivalent when guest identity
    // lands.
    uniqueIndex('meeting_presence_one_open_per_user_idx')
      .on(t.meetingId, t.userId)
      .where(sql`${t.leftAt} IS NULL AND ${t.deletedAt} IS NULL`),
    // `>=` not `>`: a zero-length join blip is a real event, not a data error.
    check(
      'meeting_presence_left_after_joined',
      sql`${t.leftAt} IS NULL OR ${t.leftAt} >= ${t.joinedAt}`
    ),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const meetingPresenceRelations = relations(meetingPresence, ({ one }) => ({
  meeting: one(meetings, {
    fields: [meetingPresence.meetingId],
    references: [meetings.id],
  }),
  user: one(users, {
    fields: [meetingPresence.userId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type MeetingPresence = typeof meetingPresence.$inferSelect;
export type NewMeetingPresence = typeof meetingPresence.$inferInsert;

/** Which SIDE a presence interval belongs to (schema-derived — single source of truth). */
export type MeetingParticipantParty = (typeof meetingParticipantPartyEnum.enumValues)[number];
