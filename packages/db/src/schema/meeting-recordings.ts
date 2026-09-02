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
import { recordingStatusEnum } from './enums';
import { meetings } from './meetings';
import { timestamps, softDelete } from './helpers';

/**
 * meeting_recordings (BAL-473) — ONE ROW PER RECORDING SEGMENT of one meeting, anchored on
 * `meetings.id` (BAL-418's primitive), following ADR-1045's "anchored artefacts get their own
 * table sharing the column contract" ruling and `meeting_files` (BAL-423) as the template.
 *
 * ── ⚠⚠ `id` IS THE CORRELATION KEY IN THREE SYSTEMS. DO NOT ADD A FOURTH COLUMN FOR IT. ──
 *
 *   Balo   `meeting_recordings.id`
 *   Daily  the `instanceId` we pass to `POST /rooms/:name/recordings/start`
 *   Mux    the `passthrough` we pass to `video.assets.create`
 *
 * This is what makes the model work at all. `recording.started`'s payload carries NO
 * `room_name` (verified against docs.daily.co) — there is no path from that event to a
 * meeting — and `recordings/start` answers `{"status":"sent"}` and nothing else, so the
 * Daily recording id is never available synchronously. The ONLY workable direction is:
 * WE mint the id, WE tell both vendors what it is, and every webhook resolves BY IT.
 *
 * ⚠ WHICH IS WHY `daily_recording_id` IS NULLABLE. The row EXISTS BEFORE Daily has one.
 * Its unique index therefore takes the TWO-CLAUSE partial form (`IS NOT NULL AND
 * deleted_at IS NULL`) that `meeting_daily_room_name_idx` uses — NOT the one-clause
 * `transcript_capture_id_idx` shape, whose column is NOT NULL. Same for `mux_asset_id`.
 *
 * ── ⚠⚠ `capture_ended_at` IS THE CAPTURE SLOT, AND IT IS NOT REDUNDANT WITH `status` ──────
 *
 * "At most one segment of a meeting may be capturing at a time" is a real database
 * guarantee here, not a convention — and it is what makes a concurrent duplicate
 * `recording-ensure` lose rather than start a second Daily recording in the same room.
 * It CANNOT be expressed as `WHERE status = 'recording'`: the house rule (see
 * `meeting-files.ts`, `transcripts.ts`, `action-items.ts`) is that an index predicate
 * references COLUMNS ONLY, never an enum literal, because a label added later by
 * `ALTER TYPE … ADD VALUE` may not be used in the same migration transaction. So the
 * predicate rides a TIMESTAMP that is stamped the moment capture ends. This is exactly the
 * shape `meetings.ended_at` already takes beside `meetings.status = 'ended'`.
 *
 * A consequence, stated so it is not rediscovered as a bug: a row stuck at `recording`
 * (Daily never sent `ready-to-download` and never sent `recording.error`) holds that ONE
 * meeting's capture slot until it is soft-deleted by hand. Blast radius is one meeting, and
 * meetings are short-lived. There is deliberately NO RETENTION reaper — a retention sweep is
 * out of scope (see the ticket's out-of-scope list) and would need its own ruling. ⚠ That is not
 * a claim that nothing reaps: BAL-480's stuck-slot reaper is described two paragraphs down, and
 * it releases a NARROWER shape (`daily_recording_id IS NULL`) than the row described here.
 *
 * ⚠ NOT CLOSED BY BAL-480's stuck-slot reaper. The reaper keys on `daily_recording_id IS NULL`
 * (see `recording-capture.ts`'s `STUCK_CAPTURE_THRESHOLD_MS`), so a row that DID learn its Daily
 * id and then never received a terminal webhook is not reaped, and the level-triggered sweep
 * ensure no-ops against it (step 5's `already_capturing`). Its manual `softDelete` remains the
 * remedy — widening the reaper's predicate to a bare age check would wrongly kill a
 * legitimately long-running segment.
 *
 * ⚠⚠ A SECOND, NARROWER RESIDUAL (fix round 1, F8), CLOSED BY BAL-480: a worker can die BETWEEN
 * `insertCapturing` committing and the Daily `recordings/start` call returning (a deploy, an
 * OOM). The row this leaves behind is INDISTINGUISHABLE FROM THE FIRST RESIDUAL BY SHAPE —
 * `status = 'recording'`, `daily_recording_id IS NULL` — but no Daily event will EVER arrive for
 * it, because Daily was never actually asked to start it. The remedy is no longer a manual
 * soft-delete: `recording-capture.ts`'s `handleEnsure` (step 5) now REAPS the row (`markFailed`
 * at stage `daily`, which releases the slot via `capture_ended_at`) and arms a fresh segment in
 * the same invocation, bounded by `MAX_DAILY_FAILURES_PER_MEETING`.
 *
 * ⚠⚠ A THIRD RESIDUAL (fix round 2, R3): a `video.asset.ready` that arrives while the row is
 * STILL `source_ready` — a fast Mux transcode racing a slow `markIngesting` commit. `markReady`'s
 * CAS requires `status = 'ingesting'`, so this delivery fails it and no-ops; the row's own
 * `mux_webhook_events` marker still commits (Mux does not retry a `200`), so when
 * `markIngesting` DOES finally commit moments later, the ready event that would have advanced
 * it has already been consumed. The row WEDGES AT `ingesting` FOREVER — the same failure mode
 * `markStarted`'s T5 residual documents on the Daily side, on the Mux side instead. Blast
 * radius is one segment, and there is deliberately no reaper for the same reason as the other
 * two: a retention/reaper sweep is out of scope and needs its own ruling. The manual
 * `softDelete` escape hatch applies here too.
 *
 * ── RETENTION: THE DAILY SOURCE GOES, THE MUX ASSET STAYS (D4) ────────────────────────────
 * `source_deleted_at` records the post-`ready` Daily delete. It is NEVER stamped before
 * `ready`: the Daily copy is the ONLY thing a failed ingest can retry from. Mux asset
 * deletion, the 12-month retention sweep and deletion-on-meeting-soft-delete are all
 * explicitly out of scope for this ticket.
 *
 * ── NOTHING HERE IS CLIENT-REACHABLE ──────────────────────────────────────────────────────
 * `daily_recording_id`, `mux_asset_id`, `failed_stage`, `failure_reason` and BAL-483's four
 * `transcript_job_*` columns are vendor/ops columns. The client-safe projection is
 * `toMeetingRecordingView` in
 * `@balo/shared/meetings`, and its test asserts none of them survive the boundary.
 * ⚠ Never hydrate this table through a relational `with:` on a client-bound read — `with:`
 * returns FULL rows, vendor/ops columns included, with no way to project them away.
 *
 * NO RLS — matching `meetings`, `meeting_contexts`, `meeting_guests`, `meeting_files`,
 * `transcripts`, `credit_sessions` and `daily_webhook_events`: Balo auths with WorkOS +
 * iron-session, `auth.uid()` is meaningless here, and the boundary is the application layer
 * (ADR-1029). This is a DELIBERATE, documented deviation from the drizzle-schema skill's
 * new-table checklist, and it matches every sibling in this family. Every writer is a
 * signature-verified webhook or a BullMQ job on the admin `db` client.
 */
export const meetingRecordings = pgTable(
  'meeting_recordings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // BAL-418's anchor. CASCADE — a recording row cannot outlive its call's row.
    // ⚠ `meetings.daily_room_name` is NULLABLE, so every recording-side path that needs a
    // room must tolerate a meeting with none.
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),

    status: recordingStatusEnum('status').notNull().default('recording'),

    /**
     * Daily's own recording id, learned from `recording.started` (by `instance_id`) or from
     * `recording.ready-to-download` (by `recording_id`). NULL until one of those lands —
     * see the docblock. `text`, not `uuid`: the format is the vendor's to change, and a
     * type that rejected a reformatted id would turn a cosmetic vendor change into an outage.
     */
    dailyRecordingId: text('daily_recording_id'),

    /** The Mux asset. Stamped by `recording-ingest`. NEVER client-reachable. */
    muxAssetId: text('mux_asset_id'),
    /** The signed-policy playback id. Stamped from `video.asset.ready`. */
    muxPlaybackId: text('mux_playback_id'),

    /** `daily` | `mux_ingest` | `mux_asset`. Free text, mirroring `transcripts.failed_stage`. */
    failedStage: text('failed_stage'),
    /** ⚠ CAPPED at 500 chars by the repository — a vendor HTML error page must not bloat the row. */
    failureReason: text('failure_reason'),

    /** When Daily says capture began (`recording.started.start_ts`). */
    startedAt: timestamp('started_at', { withTimezone: true }),
    /**
     * ⚠ THE CAPTURE SLOT — see the docblock. Stamped the moment the segment stops capturing,
     * i.e. on `source_ready` and on every `failed` transition. NULL means "Daily is still
     * capturing this segment", and `meeting_recording_capturing_idx` enforces at most one
     * such row per meeting.
     */
    captureEndedAt: timestamp('capture_ended_at', { withTimezone: true }),

    /**
     * Seconds. Daily's `ready-to-download.duration` first; OVERWRITTEN by Mux's asset
     * `duration` on `video.asset.ready` — on a `ready` row this column describes the
     * PLAYABLE artefact (what BAL-440 renders beside a player), not the pre-transcode source.
     */
    durationSeconds: integer('duration_seconds'),

    /** When Mux said the asset was playable. */
    readyAt: timestamp('ready_at', { withTimezone: true }),
    /** When `recording-cleanup-source` removed the Daily copy. ⚠ NEVER before `ready` (D4). */
    sourceDeletedAt: timestamp('source_deleted_at', { withTimezone: true }),

    // ── BAL-483 — the Daily BATCH PROCESSOR transcription job for THIS segment ──────────
    //
    // ⚠ NOT A SECOND CAPTURE SLOT. A batch job is 1:1 with a recording segment by
    // construction (`inParams` takes exactly ONE `recordingId`), and — unlike
    // `recordings/start` — `POST /batch-processor` returns the job id SYNCHRONOUSLY. There is
    // therefore no state before the id exists, no slot to hold, and no reaper. ADR-1045's
    // "more than one state before insertRaw ⇒ its own table" rule does not fire here.
    //
    // ⚠ NEVER CLIENT-REACHABLE. `toMeetingRecordingView` (`@balo/shared/meetings`) is
    // structural and names six fields; these four cannot survive it. They are additionally
    // listed in `MEETING_RECORDING_CONCEALED_KEYS` so the projection test proves it.

    /**
     * Daily's batch-processor job id, stamped from the SYNCHRONOUS `POST /batch-processor`
     * response. The PRIMARY correlation handle for `batch-processor.job-finished` /
     * `.error`, neither of which carries a room, an instance id, or a session id.
     * `text`, not `uuid`: the format is the vendor's to change (the `daily_recording_id`
     * posture, verbatim). NULL until the POST returns; may stay NULL for a submitted job
     * whose stamp lost its transaction — the `daily_recording_id` fallback covers that.
     */
    transcriptJobId: text('transcript_job_id'),
    /**
     * ⚠ THE SUBMIT GUARD, and the ONLY thing that makes "at most one batch job per segment"
     * true. `markTranscriptJobSubmitted` CASes on `IS NULL`, so a retried submit job is a
     * successful no-op rather than a second vendor charge and a second transcript.
     */
    transcriptJobSubmittedAt: timestamp('transcript_job_submitted_at', { withTimezone: true }),
    /**
     * Terminal instant for the batch job — stamped by BOTH webhook arms (finished AND error).
     * ⚠ IT GATES `recording-cleanup-source`: the batch processor DOWNLOADS the Daily
     * recording, so deleting the source while `submitted_at IS NOT NULL AND finished_at IS
     * NULL` produces Daily's documented `"Failed to download: 403 Forbidden"` and
     * permanently loses this segment's transcript.
     */
    transcriptJobFinishedAt: timestamp('transcript_job_finished_at', { withTimezone: true }),
    /** ⚠ CAPPED at `FAILURE_REASON_MAX_LENGTH` by the repository, like `failure_reason`. */
    transcriptJobFailureReason: text('transcript_job_failure_reason'),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * ⚠⚠ THE CAPTURE SLOT. At most ONE capturing segment per meeting. Predicate references
     * COLUMNS ONLY (the house rule) — which is exactly why `capture_ended_at` exists as a
     * column rather than the check being `status = 'recording'`.
     *
     * A concurrent duplicate `recording-ensure` loses this index with a raw `23505`, and
     * `meetingRecordingsRepository.insertCapturing` maps that to `undefined` — "somebody
     * else is already capturing", which is a SUCCESSFUL no-op, not an error.
     */
    uniqueIndex('meeting_recording_capturing_idx')
      .on(t.meetingId)
      .where(sql`${t.captureEndedAt} IS NULL AND ${t.deletedAt} IS NULL`),

    /**
     * THE LIST READ: a meeting's live segments in START ORDER (BAL-440 renders them in
     * order). Predicate on a column only.
     */
    index('meeting_recording_meeting_idx')
      .on(t.meetingId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),

    /**
     * One Daily recording resolves to at most ONE live row — the `ready-to-download` /
     * `recording.error` primary lookup. TWO-CLAUSE partial: the column is NULLABLE (the row
     * predates the id) and a soft-deleted row must not permanently occupy a vendor id.
     * The `meeting_daily_room_name_idx` shape, NOT `transcript_capture_id_idx`'s.
     */
    uniqueIndex('meeting_recording_daily_id_idx')
      .on(t.dailyRecordingId)
      .where(sql`${t.dailyRecordingId} IS NOT NULL AND ${t.deletedAt} IS NULL`),

    /** Same shape, same reasons — the Mux webhook's FALLBACK lookup behind `passthrough`. */
    uniqueIndex('meeting_recording_mux_asset_idx')
      .on(t.muxAssetId)
      .where(sql`${t.muxAssetId} IS NOT NULL AND ${t.deletedAt} IS NULL`),

    /**
     * ⚠ ONE-DIRECTIONAL, AND THAT IS THE POINT: an UNSETTLED capture slot must be a
     * `recording` row. It stops the dangerous drift — a `ready` or `failed` row still
     * holding its meeting's capture slot, which would make every future `recording-ensure`
     * for that meeting a silent no-op forever.
     *
     * It says nothing about the other direction, so a future non-terminal capture label
     * stays possible — but see `recordingStatusEnum`'s warning: such a label must be added
     * to this CHECK in the same change.
     *
     * NO THREE-VALUED-LOGIC HOLE: `IS NOT NULL` is total, and `status` is NOT NULL compared
     * to a literal ⇒ never NULL. SAFE TO NAME `'recording'` IN MIGRATION 0075: the type is
     * created by a STANDALONE `CREATE TYPE` in that same migration and `'recording'` is an
     * ORIGINAL label, so it commits atomically with the type (the `meeting_file_party_two_sided`
     * precedent). The hazard where a DEFAULT set to a just-added enum value fails from scratch
     * because `ALTER TYPE … ADD VALUE` cannot commit in the same transaction as its use does
     * NOT apply here — there is no such default, and the label is original to the type.
     */
    check(
      'meeting_recording_capture_slot',
      sql`${t.captureEndedAt} IS NOT NULL OR ${t.status} = 'recording'`
    ),

    /** Durations are never negative. Enum-literal-free. */
    check(
      'meeting_recording_duration_non_negative',
      sql`${t.durationSeconds} IS NULL OR ${t.durationSeconds} >= 0`
    ),

    /**
     * BAL-483 — one batch job resolves to at most ONE live row. The `batch-processor.*`
     * PRIMARY lookup. TWO-CLAUSE partial, the `meeting_recording_daily_id_idx` shape
     * verbatim: the column is NULLABLE (the row predates the job) and a soft-deleted row
     * must not permanently occupy a vendor id.
     */
    uniqueIndex('meeting_recording_transcript_job_idx')
      .on(t.transcriptJobId)
      .where(sql`${t.transcriptJobId} IS NOT NULL AND ${t.deletedAt} IS NULL`),

    /**
     * A job id implies a submission. NO THREE-VALUED-LOGIC HOLE: the left disjunct is
     * `IS NULL` (total), so the CHECK is never NULL. Enum-literal-free — the house rule.
     */
    check(
      'meeting_recording_transcript_job_submitted',
      sql`${t.transcriptJobId} IS NULL OR ${t.transcriptJobSubmittedAt} IS NOT NULL`
    ),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const meetingRecordingsRelations = relations(meetingRecordings, ({ one }) => ({
  meeting: one(meetings, { fields: [meetingRecordings.meetingId], references: [meetings.id] }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type MeetingRecording = typeof meetingRecordings.$inferSelect;
export type NewMeetingRecording = typeof meetingRecordings.$inferInsert;

/** The segment lifecycle (schema-derived — single source of truth). */
export type MeetingRecordingStatus = (typeof recordingStatusEnum.enumValues)[number];

// ── Type-agreement pin (BAL-473 plan §3.2) ────────────────────────────────
//
// ⚠ TWO DEFINITIONS OF ONE VOCABULARY, PINNED TO EACH OTHER AT COMPILE TIME. `@balo/shared`
// must not import `@balo/db` — a client component that value-imports `@balo/db` drags the
// `postgres` driver into the bundle and fails `next build` (it cannot resolve Node builtins
// like `tls`) — so the client-safe view in `packages/shared/src/meetings/recording-view.ts`
// RESTATES this union rather than importing it. This assertion makes a drift between the two
// a TYPE ERROR rather than a runtime surprise. `never` here is a build failure.
import type { MeetingRecordingStatus as SharedMeetingRecordingStatus } from '@balo/shared/meetings';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Compile-time proof the schema-derived union and `@balo/shared`'s agree. */
export type MeetingRecordingStatusAgreement = Exact<
  MeetingRecordingStatus,
  SharedMeetingRecordingStatus
>;

/**
 * ⚠⚠ FIX ROUND 1 (F6) — THE PIN WAS INERT. `MeetingRecordingStatusAgreement` above is only a
 * type ALIAS: when the two unions diverge it resolves to `never`, and a type alias resolving
 * to `never` produces NO diagnostic on its own — nothing ever reads it, so `tsc` never has a
 * reason to check it. This assignment is what makes `never` an ACTUAL build failure: `true` is
 * not assignable to `never`, so a future status added to `recordingStatusEnum` without the
 * matching edit to `@balo/shared/meetings`'s `MeetingRecordingStatus` fails `pnpm typecheck`
 * right here, instead of shipping silently.
 */
export const meetingRecordingStatusAgreement: MeetingRecordingStatusAgreement = true;
