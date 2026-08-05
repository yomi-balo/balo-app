import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { meetingStatusEnum, meetingOutcomeEnum } from './enums';
import { timestamps, softDelete } from './helpers';
import { meetingContexts } from './meeting-contexts';
import { meetingPresence } from './meeting-presence';

/**
 * meetings (BAL-418 / ADR-1045 §2 + ADR-1043 §1) — the cross-cutting Meeting primitive.
 * ONE table for every kind of live call: case consultation, project discovery/kickoff,
 * package session, retainer check-in, and Balo-internal admin calls.
 *
 * ⚠ THE LOAD-BEARING CONSTRAINT: this table carries **NO CONTEXT COLUMN** — no
 * `engagement_id`, no `credit_session_id`, no `project_request_id`, no per-context
 * nullable FK. "What is this meeting FOR" lives ENTIRELY in `meeting_contexts`
 * (the polymorphic seam), so adding a context type never widens this table. Enforced
 * mechanically by `invariants/meetings-no-context-column.test.ts` — a new context column
 * here fails that test, by design.
 *
 * NO `expert_profile_id` either, deliberately: the host is resolved THROUGH the context
 * seam (→ engagement → `expert_profile_id`), an `admin` meeting has no expert at all, and
 * host authorization is ADR-1046/BAL-413's (`hasEngagementCapability`). Who actually
 * hosted is recorded by `meeting_presence` (`party='expert'`).
 *
 * ⚠ CROSS-REFERENCE — `consultations` (schema/consultations.ts). That table is the LIVE
 * availability stub the resolver subtracts from open windows
 * (`consultations_expert_status_range_idx`). A `meetings` row with
 * `scheduled_start`/`scheduled_end` stores the same fact a SECOND time. There is no
 * regression today because BAL-418 ships NO writer that creates a meeting from a booking
 * (`meetingsRepository.create` has no caller). The regression appears the moment BAL-129
 * lands: a booked meeting would NOT block the expert's availability. RULING for BAL-129 —
 * it must either (a) write the `consultations` row and the `meetings` row in ONE
 * transaction, or (b) migrate the availability resolver to read `meetings` and retire the
 * stub. It must not ship a meeting-creating path that does neither.
 *
 * ⚠ ENUM-LITERAL CAVEAT: `'ended'` is safe inside `meeting_outcome_requires_ended` because
 * `meeting_status` is a standalone `CREATE TYPE` in the same migration (0056). A future
 * migration that `ALTER TYPE meeting_status ADD VALUE`s a label MUST NOT rewrite this CHECK
 * in that same migration (the `reference_enum_default_same_tx_migration_hazard` rule).
 *
 * NO RLS (matching the credit / action-item / transcript precedents — `transcripts.ts`,
 * `credit-sessions.ts`): access is gated at the application layer.
 *
 * BAL-418 ships the table + the read. Status TRANSITIONS are BAL-134's, PROVISIONING
 * (`daily_room_name` / `join_url`) is BAL-129's, host authorization is BAL-413's, and
 * `meeting_files` is BAL-423's. None of them exist here.
 */
export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    status: meetingStatusEnum('status').notNull().default('scheduled'),
    // WHY it ended. NULL unless `status='ended'` — the CHECK is ONE-DIRECTIONAL
    // (`outcome ⇒ ended`), never biconditional: a biconditional would force BAL-134's
    // `end` transition to decide the outcome in the same statement, which is
    // transition logic this ticket does not own.
    outcome: meetingOutcomeEnum('outcome'),

    scheduledStart: timestamp('scheduled_start', { withTimezone: true }).notNull(),
    scheduledEnd: timestamp('scheduled_end', { withTimezone: true }).notNull(),

    // BAL-134 stamps these on the lifecycle transitions.
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),

    // BAL-129 provisions these (via `meetingsRepository.setVenue`).
    dailyRoomName: text('daily_room_name'),
    joinUrl: text('join_url'),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // BAL-425 "next scheduled consultation" + BAL-134's starting-soon scans.
    index('meeting_status_scheduled_start_idx')
      .on(t.status, t.scheduledStart)
      .where(sql`${t.deletedAt} IS NULL`),
    // A Daily room resolves to exactly ONE meeting — BAL-129/BAL-131 webhooks key on it.
    // PARTIAL on deleted_at (memory `reference_softdelete_nonpartial_unique_recreate`):
    // a soft-deleted meeting must not permanently occupy its room name.
    uniqueIndex('meeting_daily_room_name_idx')
      .on(t.dailyRoomName)
      .where(sql`${t.dailyRoomName} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    check('meeting_scheduled_start_before_end', sql`${t.scheduledStart} < ${t.scheduledEnd}`),
    // NO THREE-VALUED-LOGIC HOLE: when `outcome` IS NULL the LHS is TRUE (IS NULL is
    // total); when it is NOT NULL the RHS compares a NOT NULL column to a literal ⇒ never
    // NULL. The CHECK therefore never "passes by being unknown".
    check('meeting_outcome_requires_ended', sql`${t.outcome} IS NULL OR ${t.status} = 'ended'`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const meetingsRelations = relations(meetings, ({ many }) => ({
  contexts: many(meetingContexts),
  presence: many(meetingPresence),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;

/** Meeting lifecycle status (schema-derived — single source of truth). */
export type MeetingStatus = (typeof meetingStatusEnum.enumValues)[number];
/** Why a meeting ended (schema-derived — single source of truth). */
export type MeetingOutcome = (typeof meetingOutcomeEnum.enumValues)[number];
