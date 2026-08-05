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
 *   expertPresentMs = last expert leave      − FIRST expert join                 (gap-inclusive)
 *   billableMs      = last instant both sides present − FIRST such instant       (gap-inclusive)
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
 * ⚠ THE SAME CHOICE CUTS BOTH WAYS. Gap-inclusive bills a gap of ANY size: a client
 * present 0→2 min and again 58→60 min of a 60-minute call yields `billableMs = 58 min`,
 * NOT 4. That IS the intended semantics — the expert held the slot for the whole hour, and
 * a rule that pauses billing during a gap is the rule a party could exploit by dropping —
 * but it is a real exposure at the long end. The POLICY CAP is **BAL-412's** (settlement,
 * which already carries `effectiveCeilingMinor`), with **BAL-134** clamping presence to
 * the meeting window on the write side. Neither this table nor the pure clock caps
 * anything: the only DB CHECK here is `left_at >= joined_at`.
 *
 * The clock computation itself is PURE and lives in `@balo/shared/meetings`
 * (`computeMeetingClocks`), NOT in `@balo/db`, so BAL-403's in-session client panel can
 * render it without value-importing `@balo/db` (memory
 * `reference_balo_db_client_bundle_footgun`). This table + `meetingPresenceRepository` own
 * the storage and the read; BAL-134 owns the WRITE logic.
 *
 * NO RLS (matching `meetings` / `meeting_contexts` and the credit precedents).
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
