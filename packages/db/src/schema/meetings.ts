import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { meetingStatusEnum, meetingOutcomeEnum, meetingEndedByEnum } from './enums';
import { timestamps, softDelete } from './helpers';
import { meetingContexts } from './meeting-contexts';
import { meetingPresence } from './meeting-presence';
import { meetingGuests } from './guests';
import { meetingFiles } from './meeting-files';
import { meetingRecordings } from './meeting-recordings';

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
 * ⚠⚠ BAL-400 / BAL-129 D12 — THE ATTRIBUTION COLUMN WAS DELIBERATELY **NOT** ADDED, AND
 * THIS IS THE RECORD OF THAT DECISION SO THE NEXT READER DOES NOT "FINISH THE JOB".
 * BAL-129 shipped the `meeting.booked` audit row (ADR-1030's CEILING) and left a note
 * saying its FLOOR — a `booked_by_user_id` column here — would ride BAL-400's
 * idempotency-key migration. It did not, and must not. Ratified by the owner (D5) on the
 * architect's Decision 8:
 *
 *   · `booked_by_user_id uuid ... references(users.id)` FAILS THREE of the five
 *     assertions in `invariants/meetings-no-context-column.test.ts` — the no-`_id`-suffix
 *     rule, the exactly-one-uuid-column rule, and the zero-foreign-keys rule. The last is
 *     the naming-independent one that actually holds the line, and it would become "the
 *     FKs on this list" the moment the first exception is written. Mechanical strength
 *     survives an allow-list; DETERRENT strength does not.
 *   · NOTHING READS IT. No shipped or in-scope consumer asks "who booked this meeting" off
 *     this table; cancel authorization is on the ADR-1046 ENGAGEMENT axis (delivery
 *     identity), not on "did you book it".
 *   · The ceiling already discharges the ADR requirement: `meetingsRepository.create`
 *     writes one `meeting.booked` `audit_events` row in the SAME transaction with
 *     `actor_user_id` threaded from the route. An omitted actor records NULL (the ADR-1030
 *     system-actor exemption), never a fabricated one.
 *
 * If the floor is ever genuinely wanted it is a STRUCTURAL change on its own merits: amend
 * ADR-1045 §2 in the Notion Decision Register FIRST, then edit the invariant with a written
 * justification. Not a carve-out smuggled into a feature PR.
 *
 * ⚠ THE ONE COLUMN BAL-400 DID ADD is `booking_idempotency_key`, and it passes all five
 * assertions BY CONSTRUCTION — `text`, not `uuid`; a `_key` suffix, not `_id`; no
 * `.references(`. Two traps for anyone touching this file again, because assertion 2
 * filters EVERY single-quoted literal in the comment-stripped source and not merely column
 * names: the key must never become `uuid(...)` even though its value is derived from a
 * user id, and NO index or CHECK NAME here may end in `_id` either.
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
    /**
     * BAL-134 / ADR-1049 — WHO ended it, on the axis ORTHOGONAL to `outcome`'s WHY. NULL
     * unless `status='ended'` (CHECK `meeting_ended_by_requires_ended`, one-directional for
     * the same reason `meeting_outcome_requires_ended` is). See `meetingEndedByEnum` for the
     * three labels and why all four SYSTEM paths share `system_idle`.
     *
     * ⚠ NO DEFAULT, DELIBERATELY. A default would have to name a `meeting_ended_by` label in
     * the same migration that creates the type — safe here (a standalone `CREATE TYPE`
     * commits its labels atomically) but meaningless: a `scheduled` meeting has no ender, and
     * a stamped-by-default one would be a lie every reader would have to un-learn.
     */
    endedBy: meetingEndedByEnum('ended_by'),

    scheduledStart: timestamp('scheduled_start', { withTimezone: true }).notNull(),
    scheduledEnd: timestamp('scheduled_end', { withTimezone: true }).notNull(),

    // BAL-134 stamps these on the lifecycle transitions.
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),

    // BAL-129 provisions these (via `meetingsRepository.setVenue`).
    dailyRoomName: text('daily_room_name'),
    joinUrl: text('join_url'),

    /**
     * BAL-400 — the BOOKING-LEVEL idempotency key, spanning BOTH hops of a client booking
     * (create-the-case in a web Server Action, then `POST /meetings`). A retry re-enters
     * against the meeting that already exists instead of creating a second meeting, a
     * second Daily room, a second calendar event and a second notification fan-out.
     * `services/meetings/provision-meeting.ts` states the hazard outright: two identical
     * POSTs create two meetings and two rooms.
     *
     * VALUE: a lowercase 64-char hex `sha256(userId:nonce)`, hashed SERVER-SIDE. That is
     * load-bearing rather than cosmetic — a raw client-supplied key would make the lookup
     * below an IDOR, handing a stranger who replays someone else's key that person's
     * meeting. Deriving it from the actor id makes cross-user collision structurally
     * impossible, so the lookup is actor-scoped BY CONSTRUCTION and needs no second
     * ownership query.
     *
     * ⚠ `text`, NEVER `uuid` — see the file docblock. The value is a hash, not an id, and
     * a `uuid` column here would trip the exactly-one-uuid-column invariant.
     *
     * NULLABLE, and it stays that way. The dev seeder, every pre-existing row, and the
     * `project_kickoff` / `package_session` / `project_discovery` booking paths all
     * legitimately carry none. A `NOT NULL` add would pass CI (the integration harness
     * migrates an EMPTY container) and fail against production data.
     */
    bookingIdempotencyKey: text('booking_idempotency_key'),

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
    // BAL-400 — a booking key resolves to at most ONE live meeting, which is what makes
    // "retry re-enters against the existing meeting" a database guarantee rather than a
    // convention. PARTIAL on BOTH `IS NOT NULL` and `deleted_at IS NULL`: the column is
    // nullable (most meetings carry no key, and a non-partial unique would collapse every
    // one of them onto a single NULL slot in some engines) and a soft-deleted meeting must
    // not permanently occupy its key (memory `reference_softdelete_nonpartial_unique_recreate`),
    // exactly as `meeting_daily_room_name_idx` above does for the room name.
    //
    // ⚠ THE ARBITER IS A PARTIAL INDEX, so any future `ON CONFLICT` against it must INLINE
    // its predicate literals via raw `sql` — a Drizzle `eq()` Param fails 42P10 at runtime
    // (memory `reference_pg_partial_index_arbiter_param_42p10`). The shipped write path
    // deliberately does NOT use `ON CONFLICT`: it catches 23505 and re-reads by key.
    uniqueIndex('meeting_booking_idempotency_key_idx')
      .on(t.bookingIdempotencyKey)
      .where(sql`${t.bookingIdempotencyKey} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    check('meeting_scheduled_start_before_end', sql`${t.scheduledStart} < ${t.scheduledEnd}`),
    // BAL-400 — the key is a lowercase sha256 hex digest, and the DB says so. A caller that
    // forwards a raw client nonce (the IDOR shape the column docblock warns about) fails
    // 23514 here instead of silently storing an attacker-chosen key. Enum-literal-free, so
    // the ADD-VALUE one-transaction migration hazard cannot apply.
    //
    // No three-valued-logic hole: `IS NULL` is total, and when the column IS NOT NULL the
    // RHS compares a non-NULL value to a literal pattern ⇒ never NULL.
    check(
      'meeting_booking_idempotency_key_format',
      sql`${t.bookingIdempotencyKey} IS NULL OR ${t.bookingIdempotencyKey} ~ '^[0-9a-f]{64}$'`
    ),
    // NO THREE-VALUED-LOGIC HOLE: when `outcome` IS NULL the LHS is TRUE (IS NULL is
    // total); when it is NOT NULL the RHS compares a NOT NULL column to a literal ⇒ never
    // NULL. The CHECK therefore never "passes by being unknown".
    check('meeting_outcome_requires_ended', sql`${t.outcome} IS NULL OR ${t.status} = 'ended'`),
    // BAL-134 — the SAME one-directional shape as `meeting_outcome_requires_ended`, and NOT
    // biconditional for a DIFFERENT reason than that one. There, biconditionality would force
    // the end transition to decide the OUTCOME; here it would force every already-`ended` row
    // to name an ender. `ended_by ⇒ ended` is the whole invariant: nothing may claim an ender
    // on a meeting that never ended.
    //
    // ⚠ THE ENUM-LITERAL CAVEAT IS SATISFIED, AND NOT BY LUCK. This CHECK names `'ended'` —
    // a `meeting_status` label created by the standalone `CREATE TYPE` in 0056, NOT one of
    // the `meeting_ended_by` labels created in 0066 alongside it. So even though Postgres
    // permits a just-created type's labels inside the same transaction (they are born with
    // it), this constraint would be safe even if it did not: it references no new label at
    // all. Any FUTURE `ALTER TYPE meeting_status ADD VALUE` still may not rewrite this line
    // in its own migration (`reference_enum_default_same_tx_migration_hazard`).
    //
    // No three-valued-logic hole: `IS NULL` is total, and when `ended_by` IS NOT NULL the RHS
    // compares a NOT NULL column to a literal ⇒ never NULL.
    check('meeting_ended_by_requires_ended', sql`${t.endedBy} IS NULL OR ${t.status} = 'ended'`),
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
  // BAL-473. ⚠ `reference_drizzle_with_hydration_leaks_secrets`: a bare
  // `with: { recordings: true }` hydrates `daily_recording_id`, `mux_asset_id`,
  // `failed_stage`, `failure_reason` and BAL-483's four `transcript_job_*` columns — all
  // vendor/ops columns that the client-safe projection `toMeetingRecordingView`
  // (`@balo/shared/meetings`) exists to conceal. Any
  // read that can reach a route MUST pass an explicit `columns:` projection, or go through
  // `meetingRecordingsRepository.listByMeeting` and project on the way out.
  recordings: many(meetingRecordings),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;

/** Meeting lifecycle status (schema-derived — single source of truth). */
export type MeetingStatus = (typeof meetingStatusEnum.enumValues)[number];
/** Why a meeting ended (schema-derived — single source of truth). */
export type MeetingOutcome = (typeof meetingOutcomeEnum.enumValues)[number];
/**
 * WHO ended a meeting (BAL-134 / ADR-1049 — schema-derived, single source of truth for the
 * PERSISTED value). `@balo/shared/meetings`'s `end-authority.ts` declares the same union for
 * the two apps to reason about WITHOUT value-importing `@balo/db` (the client-bundle footgun,
 * memory `reference_balo_db_client_bundle_footgun`) — that one is the wire/pure-logic type,
 * this one is derived from the pgEnum and is what a repository signature must use, so a label
 * added to the enum without updating the shared copy fails to compile at the seam between
 * them rather than silently diverging.
 */
export type MeetingEndedBy = (typeof meetingEndedByEnum.enumValues)[number];
