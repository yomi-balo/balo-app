import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { meetingStatusEnum, meetingOutcomeEnum } from './enums';
import { timestamps, softDelete } from './helpers';
import { meetingContexts } from './meeting-contexts';
import { meetingPresence } from './meeting-presence';
import { meetingGuests } from './guests';
import { meetingFiles } from './meeting-files';

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
 * ⚠ CROSS-REFERENCE — `consultations` (schema/consultations.ts). SETTLED BY BAL-428
 * (Option C). BAL-418 left these as TWO INDEPENDENT RECORDS of the same booked-slot fact
 * and handed BAL-129 a ruling to reconcile them. BAL-428 did it instead, and the answer is
 * NOT the one BAL-418's docblock leaned toward:
 *
 *   `consultations` is now a READ MODEL OF THIS TABLE, not a sibling. It carries a NOT NULL
 *   `meeting_id` FK to `meetings.id`, so a booked meeting that blocks nothing is
 *   UNREPRESENTABLE rather than merely discouraged. `meetings` remains the source of truth
 *   for the booked window; the projection exists so the availability resolver keeps its
 *   narrow, index-backed read (`consultations_expert_status_range_idx`) instead of dragging
 *   the whole meeting lifecycle into the hot path.
 *
 * ⚠ THIS TABLE GAINED NO COLUMN FOR ANY OF THAT, and must not. There is no
 * `consultation_id` here and no reverse relation on `meetingsRelations` — the FK and the
 * relation both point THIS way, from the projection to the meeting. The projection's ONLY
 * writer is `repositories/_shared/consultation-projection.ts`, driven from
 * `meetingsRepository` (`create` / `updateSchedule` / `cancel` / `softDelete`) and from
 * `meetingContextsRepository.attach`, always inside their existing transactions.
 *
 * WHAT BAL-428 DID NOT CLOSE: two simultaneous bookings for one window can still both
 * commit — there is no EXCLUDE constraint. It closed the STALE-AVAILABILITY
 * double-booking, not the RACE.
 *
 * ⚠ ENUM-LITERAL CAVEAT: `'ended'` is safe inside `meeting_outcome_requires_ended` because
 * `meeting_status`'s original four labels were created by a standalone `CREATE TYPE` in
 * migration 0056. `'cancelled'` was added by BAL-428 via `ALTER TYPE … ADD VALUE` in 0059,
 * which is exactly why 0059 does NOT rewrite this CHECK and adds NO CHECK naming the new
 * label (the `reference_enum_default_same_tx_migration_hazard` rule). Any future
 * ADD-VALUE migration inherits the same prohibition.
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
  // BAL-408. ⚠ `reference_drizzle_with_hydration_leaks_secrets`: a bare
  // `with: { guests: true }` hydrates `token_hash` and every guest's `email`. Any read that
  // can reach a route MUST pass an explicit `columns:` projection.
  guests: many(meetingGuests),
  // BAL-423. ⚠ `reference_drizzle_with_hydration_leaks_secrets`: a bare
  // `with: { files: true }` hydrates `r2_key`, which is an OBJECT LOCATOR — the exact
  // string `createPresignedMeetingFileDownload` signs. Any read that can reach a route MUST
  // pass an explicit `columns:` projection that omits it.
  files: many(meetingFiles),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;

/** Meeting lifecycle status (schema-derived — single source of truth). */
export type MeetingStatus = (typeof meetingStatusEnum.enumValues)[number];
/** Why a meeting ended (schema-derived — single source of truth). */
export type MeetingOutcome = (typeof meetingOutcomeEnum.enumValues)[number];
