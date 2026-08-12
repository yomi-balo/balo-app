import { pgTable, uuid, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { meetingParticipantPartyEnum } from './enums';
import { meetings } from './meetings';
import { meetingGuests } from './guests';
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
 *
 * ── ⚠⚠ BAL-408: THE GUEST GAP IS CLOSED, AND THE WRITE CONTRACT BAL-134 MUST HONOUR ────
 *
 * BAL-418 left a documented hole: `meeting_presence_one_open_per_user_idx` keys on
 * `user_id`, which is NULL for a guest, and NULLs are DISTINCT in a unique index — so a
 * duplicate guest join webhook could open a SECOND open interval and double-count the
 * clocks. BAL-408 lands guest identity, so the gap is closed HERE, by
 * `meeting_guest_id` + `meeting_presence_one_open_per_guest_idx` +
 * `meeting_presence_identity_not_both`. The column, index and CHECK ship INERT: this PR
 * writes no presence row.
 *
 * **BAL-134 OWNS THE WRITE, AND OWES THIS TABLE EXACTLY TWO THINGS:**
 *
 *   1. FOR A TOKEN-AUTHENTICATED GUEST, SET `meeting_guest_id` — NEVER `user_id`. A guest
 *      is not a Balo user; writing `user_id` would both violate the identity CHECK (if both
 *      were set) and silently re-open the duplicate-interval gap (if only `user_id` were).
 *
 *   2. ⚠ THE MONEY RULE — DERIVE `party` VIA `presencePartyForGuest` (`@balo/shared/meetings`),
 *      NEVER FROM THE GUEST ROW'S `party` DIRECTLY. `computeMeetingClocks` reads
 *      `expertPresentMs` (and anchors `billableMs`) off `party='expert'` rows as
 *      GAP-INCLUSIVE SPANS. An EXPERT-SIDE GUEST written as `party='expert'` would
 *      therefore put a NON-DELIVERING attendee on the billable clock: an agency colleague
 *      present 0→60 while the delivering expert is present only 10→20 yields
 *      `expertPresentMs = 60 min` and a `billableMs` span anchored on the GUEST — the
 *      client billed for a guest's time, in direct violation of "per-minute of expert time,
 *      never per-seat". The mapping is `client → client`, `expert → observer`, and
 *      `observer` was declared for exactly this class of attendee. A client-side guest DOES
 *      map to `client`, on purpose: the client party is genuinely represented, so the
 *      billable intersection should continue if the booker drops but their colleague stays.
 *
 * ── ⚠⚠ BAL-132 HAND-OFF: A `link`-CHANNEL GUEST'S `party` IS A PLACEHOLDER ──────────────
 *
 * BAL-132 shipped the LOBBY: an anonymous visitor at a bare meeting URL self-claims a place
 * in the admission queue (`meetingGuestsRepository.claimLobbyPlace`), and is the platform's
 * first producer of `invite_channel = 'link'` and `admission = 'pending'`.
 *
 * ⚠ SUCH A ROW'S `party` IS SELF-DECLARED — OR RATHER, NOT DECLARED BY ANYONE AT ALL. An
 * `email`-channel guest's `party` is SERVER-RESOLVED from the inviter's own authorized side
 * (`authorizeMeetingParticipation`); a bare meeting URL carries NO sharer identity, so there
 * is no equivalent signal for a knock. `meeting_guests.party` is NOT NULL and CHECK-narrowed
 * to `client | expert`, so the lobby writer stores `client` because the COLUMN DEMANDS A
 * VALUE — not because a side was resolved. **IT MUST NEVER ANCHOR `billableMs`.**
 *
 * ⚠⚠ AND THAT OBLIGATION IS NOW MECHANICAL, NOT A REQUEST IN THIS PARAGRAPH. `presencePartyForGuest`
 * takes the guest's `invite_channel` as a **NON-OPTIONAL** argument and maps EVERY
 * `link`-channel row to `observer` regardless of the stored `party`. So obligation (2) above
 * is discharged by construction for lobby guests: derive `party` through that function — which
 * you must do anyway — and the placeholder can no longer reach a billing clock. A one-argument
 * call no longer compiles, which is the whole reason the signature was widened in BAL-132's
 * slice rather than left as prose here for a later reader to miss.
 *
 * The number this buys, pinned in `@balo/shared/meetings`'s `index.test.ts`: on a 60-minute
 * call where the real client leaves at minute 10 and a forwarded-link attendee stays to 60,
 * `billableMs` is **10 minutes**, not 60.
 */
export const meetingPresence = pgTable(
  'meeting_presence',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),

    // NULL for a guest (a guest's identity is `meeting_guest_id` below). SET NULL, not
    // restrict: `admin-dev/_actions/delete-user.ts` HARD-deletes users, and a presence
    // interval is a BILLING input (BAL-412) that must survive the actor row. `party`
    // preserves the side even after the user is gone.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    /**
     * BAL-408 — the GUEST identity for this interval, mutually exclusive with `user_id`
     * (`meeting_presence_identity_not_both`). NULL for an authenticated participant.
     *
     * `set null` for the SAME reason `user_id` is, not because guests are cheap: a presence
     * interval is a BILLING input that must survive the identity row, and `party` preserves
     * the side regardless. `restrict` would let a guest row block a settlement-bearing
     * interval from ever being cleaned up.
     */
    meetingGuestId: uuid('meeting_guest_id').references(() => meetingGuests.id, {
      onDelete: 'set null',
    }),

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
    // BAL-408 — the guest FK's own read path (and its `set null` delete-time scan).
    index('meeting_presence_guest_idx').on(t.meetingGuestId),
    // At most ONE open interval per authenticated participant — a duplicate join webhook
    // cannot create a second open interval that would double-count the clocks.
    // ⚠ THE GUEST GAP BAL-418 LEFT HERE IS CLOSED BY THE SIBLING INDEX BELOW, not by this
    // one: `user_id` is NULL for a guest and NULLs are DISTINCT in a unique index, so this
    // index never covered a guest and — because `meeting_guest_id` is a SEPARATE column —
    // still does not. The two indexes are complementary, not redundant.
    uniqueIndex('meeting_presence_one_open_per_user_idx')
      .on(t.meetingId, t.userId)
      .where(sql`${t.leftAt} IS NULL AND ${t.deletedAt} IS NULL`),
    // BAL-408 — the guest-keyed equivalent, closing the gap above now that guest identity
    // exists. `meeting_guest_id IS NOT NULL` is required in the predicate for the same
    // reason the gap existed at all: without it, every authenticated row (guest id NULL)
    // would collide as a single indistinct NULL group... which it would not, because NULLs
    // are distinct — but the predicate keeps the index SMALL and states the intent. The
    // predicate names COLUMNS ONLY, never an enum literal (the house rule at
    // `action-items.ts` / `transcripts.ts`).
    uniqueIndex('meeting_presence_one_open_per_guest_idx')
      .on(t.meetingId, t.meetingGuestId)
      .where(
        sql`${t.meetingGuestId} IS NOT NULL AND ${t.leftAt} IS NULL AND ${t.deletedAt} IS NULL`
      ),
    // `>=` not `>`: a zero-length join blip is a real event, not a data error.
    check(
      'meeting_presence_left_after_joined',
      sql`${t.leftAt} IS NULL OR ${t.leftAt} >= ${t.joinedAt}`
    ),
    // BAL-408 — AT MOST ONE identity per interval. Deliberately NOT "exactly one": BAL-134
    // may legitimately observe a raw Daily participant it cannot map to either table, and
    // forcing it to write a lie is worse than allowing a NULL identity with a known `party`.
    // Three-valued-logic safe: both operands are total `IS NOT NULL` tests.
    check(
      'meeting_presence_identity_not_both',
      sql`NOT (${t.userId} IS NOT NULL AND ${t.meetingGuestId} IS NOT NULL)`
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
  // ⚠ `reference_drizzle_with_hydration_leaks_secrets`: hydrating this relation with a bare
  // `with: { guest: true }` pulls the guest's `token_hash` and `email`. Any read that can
  // reach a route MUST pass an explicit `columns:` projection.
  guest: one(meetingGuests, {
    fields: [meetingPresence.meetingGuestId],
    references: [meetingGuests.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type MeetingPresence = typeof meetingPresence.$inferSelect;
export type NewMeetingPresence = typeof meetingPresence.$inferInsert;

/** Which SIDE a presence interval belongs to (schema-derived — single source of truth). */
export type MeetingParticipantParty = (typeof meetingParticipantPartyEnum.enumValues)[number];
