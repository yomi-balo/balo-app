import { pgTable, uuid, smallint, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { rescheduleProposalStatusEnum } from './enums';
import { meetings } from './meetings';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * `reschedule_proposals` (BAL-411 / ADR-1044) — ONE expert-initiated ask: "can we move this
 * consultation to one of these times instead?". The client accepts one option, declines, or
 * lets it lapse at the original start.
 *
 * ── NOTHING IS HELD. A PROPOSAL IS A SOFT HOLD BY CONSTRUCTION. ────────────────────────
 * A proposal writes NO `consultations` row, so the proposed slots stay bookable by anyone
 * until one is accepted. `isWindowAvailableForExpert` reads `consultations` + vendor busy
 * only, so an unwritten proposal is invisible to the booking gate — that is why there is no
 * hold table, no lock column and no reservation here, and why "the accepted slot was taken
 * in the meantime" is a normal, handled outcome of the accept path rather than an anomaly.
 * ⚠ DO NOT BUILD ONE. And a proposal moves NO MONEY: it opens, closes and alters no
 * `credit_session` and places no `credit_holds` row (holds are placed at CALL time inside
 * `openSession`, never at booking time).
 *
 * ── ANCHORED ON THE MEETING, NEVER ON AN ENGAGEMENT ───────────────────────────────────
 * There is deliberately NO `engagement_id` and NO `expert_profile_id` column. The owning
 * party is resolved through the ADR-1045 §2 context seam (`meeting_contexts`), never
 * duplicated here — `schema/meeting-contexts.ts` names BAL-409/410/**411** as still carrying
 * exactly that obligation, and a second answer to "who owns this meeting" is how two answers
 * drift apart. The case surface already holds the case's meeting ids, so its read is
 * `findLivePendingByMeetingIds(meetingIds)`.
 * ⚠ THE TENANCY OBLIGATION IS THE CALLER'S, unchanged: every caller must resolve the
 * meeting's owning party through the seam and check a capability against it BEFORE passing a
 * `meetingId` in. A gate inside a repository would be the deviation (ADR-1029).
 *
 * ── AND NO COLUMN ON `meetings` ───────────────────────────────────────────────────────
 * `packages/db/src/invariants/meetings-no-context-column.test.ts` would fail on one; the
 * proposal lives beside the meeting, not on it.
 *
 * ── THE ROW IS THE LEDGER — NO NEW `audit_events` ACTIONS ─────────────────────────────
 * (id, actor, status, `created_at`, `resolved_at`) is the whole history of the ask, and the
 * row's `id` is unique per write, which is the only property the outbound fan-out keys need
 * (§D6: key every outbound on the WRITE's own append-only id, never on the target window).
 * An ACCEPT still writes `meeting.rescheduled` via `meetingsRepository.updateSchedule`,
 * unchanged, and that audit row's id remains the fan-out key for the move itself.
 *
 * ── NO FREE-TEXT NOTE ─────────────────────────────────────────────────────────────────
 * The ticket asks for none, and a cross-party free-text field is a new PII/abuse surface
 * with its own copy review. Do not add one without that review.
 *
 * NO RLS — matching `meetings`, `meeting_contexts`, `meeting_guests`, `meeting_files`,
 * `scheduled_notifications`, `transcripts` and the credit tables (ADR-1040 Decision 4):
 * Balo authenticates with WorkOS + iron-session, `auth.uid()` is meaningless here, every
 * reader is the admin `db` client (which bypasses RLS anyway), and the boundary is the
 * application layer (ADR-1029). A policy on this table would be both inconsistent and inert.
 */
export const rescheduleProposals = pgTable(
  'reschedule_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // BAL-418's anchor. CASCADE — a proposal cannot outlive the call it is about (the
    // `meeting_contexts` / `meeting_files` / `meeting_guests` child-of-meeting convention).
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),

    // ATTRIBUTION — restrict (ADR-1030). The proposing expert must survive their own
    // departure from the agency: rights sit on membership and are re-derived at every gate
    // call, while this column records who actually asked.
    proposedByUserId: uuid('proposed_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    status: rescheduleProposalStatusEnum('status').notNull().default('pending'),

    /**
     * The meeting's `scheduled_start` AS IT WAS AT PROPOSE TIME — the STALENESS ANCHOR
     * (§D7 step 4), and load-bearing rather than decorative.
     *
     * If the CLIENT moves the meeting (BAL-409) while a proposal is pending, the options
     * were computed against a window that no longer exists. Every answer path compares this
     * against the meeting's live `scheduled_start` and refuses on a mismatch
     * (`proposal_stale`). It is derived AT ANSWER TIME rather than cascaded from BAL-409's
     * write path on purpose — no cross-ticket cascade, no second writer.
     */
    originalScheduledStart: timestamp('original_scheduled_start', {
      withTimezone: true,
    }).notNull(),

    /**
     * The DEADLINE. Distinct from `original_scheduled_start` as a matter of type even
     * though today's only writer sets them equal — "when does the ask lapse" and "what
     * window was this computed against" are two different questions, and collapsing them
     * would make a future shorter deadline a schema change instead of a value change.
     * The CHECK below pins the one relationship that must always hold.
     *
     * ⚠ NEVER REVISITED BY A BACKGROUND PROCESS (§D1 — expiry is LAZY). Truth is derived at
     * read time by `deriveRescheduleProposalState`, and enforcement does not depend on that
     * derivation: every answer path carries `status = 'pending' AND expires_at > $now` in
     * its WHERE, so a lapsed proposal is structurally unanswerable.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /** When `status` left `pending`. Paired with `status` by CHECK — see below. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    /**
     * The client who accepted/declined, or the expert who withdrew. `NULL` for `expired`
     * (nobody acted — ADR-1030's system-actor attribution exemption: an unattributed row,
     * never a fabricated actor).
     *
     * `set null` rather than `restrict`: unlike `proposed_by_user_id` this records who
     * ANSWERED, and the proposal's history survives the answerer's hard deletion with the
     * `resolved_at` fact intact. ⚠ It is therefore NOT a reliable audit column for a deleted
     * user; `resolved_at` + `status` are.
     */
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * ⚠ THE ANSWER TO "IS MORE THAN ONE PENDING PROPOSAL PER MEETING REPRESENTABLE?" — NO.
     *
     * PARTIAL ON BOTH HALVES, and both are load-bearing:
     *  · `deleted_at IS NULL` — the hard-learned house convention (memory
     *    `reference_softdelete_nonpartial_unique_recreate`; the shipped shape is
     *    `scheduled_notification_pending_key_idx`). Soft-delete plus a NON-partial unique
     *    makes any re-create fail SILENTLY.
     *  · `status = 'pending'` — without it a meeting could carry ONE proposal for its entire
     *    life: answer it, and the expert could never ask again.
     *
     * ⚠ IT CANNOT KNOW ABOUT EXPIRY. `now()` is not IMMUTABLE and may not appear in an index
     * predicate, so a LAPSED proposal still occupies this slot. The gap is closed at the
     * WRITE path — `rescheduleProposalsRepository.propose` runs `expireStaleForMeeting` as
     * its FIRST statement inside the propose transaction. Without that, a meeting the client
     * later moved forward would carry a dead `pending` row blocking every future proposal.
     *
     * ⚠ NO `ON CONFLICT` ANYWHERE AGAINST THIS INDEX. The propose path is
     * expire-then-INSERT, with a raw `23505` caught and mapped to
     * `RescheduleProposalAlreadyPendingError` (the `meetingsRepository.create` counter-
     * precedent). If a future change reaches for `onConflictDoUpdate`, the arbiter must
     * restate this predicate with the enum literal INLINED via raw `sql` or Postgres fails
     * `42P10` (memory `reference_pg_partial_index_arbiter_param_42p10`).
     */
    uniqueIndex('reschedule_proposal_one_pending_idx')
      .on(t.meetingId)
      .where(sql`${t.status} = 'pending' AND ${t.deletedAt} IS NULL`),

    /** The case surface's read: this meeting's live proposals, across all statuses. */
    index('reschedule_proposal_meeting_idx')
      .on(t.meetingId)
      .where(sql`${t.deletedAt} IS NULL`),

    /**
     * The FK delete-time scans. Indexed on the `meeting_files` reasoning: a FK whose scan
     * can actually run needs an index, and `admin-dev/_actions/delete-user.ts` proves users
     * really are hard-deleted. Both columns get one — `restrict` makes the delete FAIL and
     * `set null` makes it WRITE, and either way Postgres scans this table.
     */
    index('reschedule_proposal_proposed_by_idx').on(t.proposedByUserId),
    index('reschedule_proposal_resolved_by_idx').on(t.resolvedByUserId),

    /**
     * THE BICONDITIONAL — a resolved proposal has a resolution time and a pending one does
     * not (the `case_engagement_resolution_request_paired` / `meeting_context_admin_no_id`
     * precedent).
     *
     * NO THREE-VALUED-LOGIC HOLE:
     *   LHS `status = 'pending'` — `status` is NOT NULL and 'pending' is a literal ⇒ never NULL.
     *   RHS `resolved_at IS NULL` — IS NULL is total, never yields NULL.
     * boolean = boolean over two non-NULL operands ⇒ TRUE or FALSE. It can never "pass by
     * being unknown".
     *
     * ⚠ THIS IS WHAT MAKES THE §D7 step-9c COMPENSATOR (`revertAccept`) A REAL REVERT: going
     * back to `pending` MUST also clear `resolved_at`, or the write is refused here.
     */
    check(
      'reschedule_proposal_resolution_paired',
      sql`(${t.status} = 'pending') = (${t.resolvedAt} IS NULL)`
    ),

    /**
     * The ask can never outlive the booking it is about. Both operands are NOT NULL, so this
     * is total. `<=` and not `<`: today's writer sets the two equal (the deadline IS the
     * original start), which must remain legal.
     */
    check(
      'reschedule_proposal_expires_within_window',
      sql`${t.expiresAt} <= ${t.originalScheduledStart}`
    ),
  ]
);

/**
 * `reschedule_proposal_options` (BAL-411) — the ≤3 alternative times of one proposal.
 *
 * ── THE "UP TO 3" CAP IS STRUCTURAL, NOT AN APPLICATION RULE ──────────────────────────
 * `reschedule_proposal_option_position_range` (0 ≤ position < 3) plus the
 * `(proposal_id, position)` partial unique make a fourth option unrepresentable. No trigger,
 * no count query, no "the service checks it" — three independent writers cannot disagree
 * about a constraint the database enforces.
 *
 * ── THE WINNER LIVES HERE, NOT AS `reschedule_proposals.accepted_option_id` ───────────
 * A pointer on the parent would be a CIRCULAR FK between the two tables and an awkward
 * `drizzle-kit generate` ordering, for no gain: `accepted_at` on the option, plus the
 * `reschedule_proposal_option_accepted_idx` partial unique, expresses "at most one accepted
 * option per proposal" exactly as strongly and in one place.
 *
 * NO RLS — see `reschedule_proposals`.
 */
export const rescheduleProposalOptions = pgTable(
  'reschedule_proposal_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // CASCADE — an option cannot outlive its proposal.
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => rescheduleProposals.id, { onDelete: 'cascade' }),

    /** 0-based DISPLAY order. Bounded to 0..2 by CHECK — see the table docblock. */
    position: smallint('position').notNull(),

    scheduledStart: timestamp('scheduled_start', { withTimezone: true }).notNull(),

    /**
     * Server-pinned at propose time from the meeting's own duration.
     *
     * ⚠ DISPLAY ONLY. THE ACCEPT PATH NEVER TRUSTS IT — it RE-PINS the duration from the
     * live meeting at accept time (`scheduledStart + (meeting.scheduledEnd −
     * meeting.scheduledStart)`), so a meeting whose duration changed between propose and
     * accept cannot be moved to a stale-length window.
     */
    scheduledEnd: timestamp('scheduled_end', { withTimezone: true }).notNull(),

    /** Stamped on THE winning option by `accept`; cleared by the `revertAccept` compensator. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /** Half of the structural "up to 3" cap — see the table docblock. */
    uniqueIndex('reschedule_proposal_option_position_idx')
      .on(t.proposalId, t.position)
      .where(sql`${t.deletedAt} IS NULL`),

    /** No duplicate slots inside one proposal. The 400 `duplicate_option` backstop. */
    uniqueIndex('reschedule_proposal_option_start_idx')
      .on(t.proposalId, t.scheduledStart)
      .where(sql`${t.deletedAt} IS NULL`),

    /**
     * AT MOST ONE ACCEPTED OPTION PER PROPOSAL. Predicated on `accepted_at IS NOT NULL` (a
     * column, never an enum literal — the `action-items.ts` house rule) plus the mandatory
     * `deleted_at IS NULL` half.
     */
    uniqueIndex('reschedule_proposal_option_accepted_idx')
      .on(t.proposalId)
      .where(sql`${t.acceptedAt} IS NOT NULL AND ${t.deletedAt} IS NULL`),

    /**
     * Strict `<`, matching `meeting_scheduled_start_before_end` — these are WINDOWS, and a
     * zero-length consultation is not a thing. (`<=` is the DATE-RANGE convention in
     * `availability.ts`; do not copy it here.) Both operands NOT NULL ⇒ total.
     */
    check(
      'reschedule_proposal_option_start_before_end',
      sql`${t.scheduledStart} < ${t.scheduledEnd}`
    ),

    /** The other half of the structural cap. `position` is NOT NULL ⇒ total. */
    check(
      'reschedule_proposal_option_position_range',
      sql`${t.position} >= 0 AND ${t.position} < 3`
    ),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const rescheduleProposalsRelations = relations(rescheduleProposals, ({ one, many }) => ({
  meeting: one(meetings, {
    fields: [rescheduleProposals.meetingId],
    references: [meetings.id],
  }),
  options: many(rescheduleProposalOptions),
}));

export const rescheduleProposalOptionsRelations = relations(
  rescheduleProposalOptions,
  ({ one }) => ({
    proposal: one(rescheduleProposals, {
      fields: [rescheduleProposalOptions.proposalId],
      references: [rescheduleProposals.id],
    }),
  })
);

// ── Type exports ───────────────────────────────────────────────────────

export type RescheduleProposal = typeof rescheduleProposals.$inferSelect;
export type NewRescheduleProposal = typeof rescheduleProposals.$inferInsert;
export type RescheduleProposalOption = typeof rescheduleProposalOptions.$inferSelect;
export type NewRescheduleProposalOption = typeof rescheduleProposalOptions.$inferInsert;

/** The proposal lifecycle (schema-derived — single source of truth). */
export type RescheduleProposalStatus = (typeof rescheduleProposalStatusEnum.enumValues)[number];
