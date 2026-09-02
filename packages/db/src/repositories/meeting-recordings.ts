import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../client';
import { meetingRecordings } from '../schema';
import type { MeetingRecording } from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/**
 * ⚠ A CAP, NOT PAGINATION. A meeting with 50 segments is already pathological (Daily only
 * starts a new segment after an idle stop + a rejoin); the caller warns at the cap rather
 * than truncating silently. The order is oldest-first, so a truncated list drops the NEWEST
 * segments. When a caller genuinely needs more, it adds a keyset on
 * `meeting_recording_meeting_idx` — never a bigger number.
 */
export const MEETING_RECORDING_LIST_LIMIT = 50;

/**
 * ⚠ A vendor error body can be an entire HTML page (or a stack trace, or a signed URL). Cap
 * it before it reaches a `text` column, so one bad upstream response cannot bloat the row —
 * and so `failure_reason` stays something a runbook can read at a glance.
 */
export const FAILURE_REASON_MAX_LENGTH = 500;

/** {@link meetingRecordingsRepository.insertCapturing} — the row the ensure job mints. */
export interface InsertCapturingRecordingInput {
  meetingId: string;
}

/** {@link meetingRecordingsRepository.markStarted} — T2, from Daily `recording.started`. */
export interface MarkRecordingStartedInput {
  id: string;
  dailyRecordingId: string;
  /** Daily's `start_ts`, already decoded to a Date by the webhook's Zod boundary. */
  startedAt: Date;
}

/** {@link meetingRecordingsRepository.markSourceReady} — T3, from `recording.ready-to-download`. */
export interface MarkRecordingSourceReadyInput {
  id: string;
  /** Filled only when the row does not already carry one (COALESCE semantics). */
  dailyRecordingId?: string | null;
  /** Daily's `duration`, which §18/19 records as unverified — may legitimately be null. */
  durationSeconds?: number | null;
  /** Backfilled only when the row does not already carry one (a dropped `recording.started`). */
  startedAt?: Date | null;
  /** The capture-slot release instant. Stamped into `capture_ended_at`. */
  at: Date;
}

/** {@link meetingRecordingsRepository.markIngesting} — T6, from `recording-ingest`. */
export interface MarkRecordingIngestingInput {
  id: string;
  muxAssetId: string;
}

/** {@link meetingRecordingsRepository.markReady} — T8, from Mux `video.asset.ready`. */
export interface MarkRecordingReadyInput {
  id: string;
  /**
   * ⚠⚠ FIX ROUND 2 (R3) — THE ASSET id THIS `video.asset.ready` EVENT DESCRIBES (Mux's
   * `data.id`), CAS'd against the row's own `mux_asset_id`. See {@link markReady}'s docblock
   * for the orphan-asset hazard this closes.
   */
  muxAssetId: string;
  muxPlaybackId: string;
  /** ⚠ Mux's duration WINS over Daily's when present — see the column docblock. */
  durationSeconds?: number | null;
  at: Date;
}

/** {@link meetingRecordingsRepository.markFailed} — T4/T5/T7/T9. */
export interface MarkRecordingFailedInput {
  id: string;
  /** `daily` | `mux_ingest` | `mux_asset`. Free text, mirroring `transcripts.failed_stage`. */
  stage: string;
  /** ⚠ Capped at {@link FAILURE_REASON_MAX_LENGTH} by this repository, never by the caller. */
  reason: string;
  at: Date;
  /**
   * ⚠⚠ BAL-480 FIX ROUND 1 — AN **OPTIONAL** NARROWING TERM, ADDED FOR ONE CALLER: the
   * stuck-slot reaper in `apps/api/src/jobs/recording-capture.ts`. When `true`, the CAS
   * additionally requires `daily_recording_id IS NULL`.
   *
   * ⚠ ABSENT ⇒ THE TERM IS NOT EMITTED AT ALL, so every existing caller keeps today's exact
   * semantics. The others are all stamping a failure they OBSERVED (a vendor `recording.error`,
   * a Mux failure, their own failed start call) and must still win against a row that already
   * knows its Daily id.
   *
   * ⚠⚠ WHY THE REAPER NEEDS IT — A TOCTOU THAT DOUBLE-BILLS. The reaper decides a row is stuck
   * from a read taken earlier in the same invocation, and {@link markStarted} does **not** move
   * `status`, so the base CAS (`status <> 'ready' AND status <> 'failed'`) cannot see a
   * `recording.started` that commits inside that window. Without this term the reap would
   * overwrite a LATE acknowledgement: a row that HAS a Daily id is marked `failed`, its slot is
   * released, and the same invocation starts a SECOND Daily recording in the same room — two
   * concurrent captures, both billing — while the first one's `ready-to-download` is then
   * refused by {@link markSourceReady}'s `status = 'recording'` CAS and lost. The reaper's
   * threshold selects precisely for LATE deliveries, so the window is not theoretical.
   *
   * With the term the late acknowledgement WINS: this returns `undefined`, the slot is still
   * held, and the reaper's fall-through insert loses the partial unique index cleanly.
   */
  onlyIfUnacknowledged?: boolean;
}

/** {@link meetingRecordingsRepository.markSourceDeleted} — T10, from `recording-cleanup-source`. */
export interface MarkRecordingSourceDeletedInput {
  id: string;
  at: Date;
}

/**
 * {@link meetingRecordingsRepository.markTranscriptJobSubmitted} — BAL-483 B1, from the
 * `transcript-capture` submit job, once `POST /batch-processor` has answered with an id.
 */
export interface MarkTranscriptJobSubmittedInput {
  id: string;
  /** Daily's batch-processor job id, returned SYNCHRONOUSLY by the submit call. */
  transcriptJobId: string;
  at: Date;
}

/**
 * {@link meetingRecordingsRepository.markTranscriptJobSubmitFailed} — BAL-483 FIX ROUND 3, B1e:
 * a PRE-submission terminal failure of the `transcript-capture` submit job (stage
 * `batch_submit`) — the `POST /batch-processor` call itself failed, or its synchronous
 * response was never recorded. See the mutator's own docblock for why this is a SEPARATE
 * write from {@link meetingRecordingsRepository.markTranscriptJobFailed}, never a shared one.
 */
export interface MarkTranscriptJobSubmitFailedInput {
  id: string;
  /** ⚠ Capped at {@link FAILURE_REASON_MAX_LENGTH} by this repository, never by the caller. */
  reason: string;
}

/**
 * {@link meetingRecordingsRepository.markTranscriptJobFinished} — BAL-483 B2t, from the
 * `batch-processor.job-finished` webhook arm.
 */
export interface MarkTranscriptJobFinishedInput {
  id: string;
  at: Date;
}

/**
 * {@link meetingRecordingsRepository.markTranscriptJobFailed} — BAL-483 B2e, from the
 * `batch-processor.error` webhook arm (and from any terminal submit-side give-up).
 */
export interface MarkTranscriptJobFailedInput {
  id: string;
  /** ⚠ Capped at {@link FAILURE_REASON_MAX_LENGTH} by this repository, never by the caller. */
  reason: string;
  at: Date;
}

/**
 * {@link meetingRecordingsRepository.findInMeeting} — the BAL-440 client-reachable read.
 * Deliberately OUTSIDE the T1–T10 block above: it moves nothing, it only reads.
 */
export interface FindMeetingRecordingInput {
  /** ⚠ THE GATE-VALIDATED meeting. It is a WHERE-clause term, never a post-filter. */
  meetingId: string;
  recordingId: string;
}

/**
 * `meetingRecordingsRepository` (BAL-473) — THE RECORDING STATE MACHINE'S ONLY WRITER.
 *
 * ⚠⚠ EVERY MUTATOR IS A COMPARE-AND-SET, AND `undefined` IS A SUCCESSFUL NO-OP. Read that
 * sentence before changing any WHERE clause below. There are five writers of this table
 * (two Daily webhook arms, two Mux webhook arms, three BullMQ jobs) and NONE of them can be
 * trusted to fire exactly once: Daily and Mux both retry aggressively, BullMQ retries on
 * failure, and the lifecycle sweep re-drives transitions the webhook may have missed. The
 * `status = '<expected>'` term in each predicate is what makes the SECOND delivery of any
 * event update zero rows instead of clobbering a later state. A caller that sees `undefined`
 * logs at `info` and acks — it does NOT retry and does NOT raise.
 *
 * ⚠ NOT EVERY REFUSAL MEANS "the same event, twice" — `markFailed`'s predicate ALSO excludes
 * `status = 'failed'` (fix round 1, F10), because `failed` is a state THREE different arms
 * (T4/T5, T7, T9) can each independently reach for the SAME row, at DIFFERENT vendor stages,
 * with DIFFERENT root causes. Without that exclusion a second, unrelated failure overwrote the
 * first one's `failed_stage`/`failure_reason`, contradicting the "compare-and-set" framing
 * above: this is FIRST-FAILURE-WINS, not merely "second delivery of the same event is a
 * no-op". `captureEndedAt`'s COALESCE already protects the release instant the same way.
 *
 * ⚠ THE STATE MACHINE, IN ONE PLACE (plan §5.1). Any change here must change that table too:
 *
 *   (none)       → recording      insertCapturing     T1
 *   recording    → recording      markStarted         T2   (stamps the Daily id, not the status)
 *   recording    → source_ready   markSourceReady     T3   (releases the capture slot)
 *   recording    → failed         markFailed          T4/T5
 *   source_ready → ingesting      markIngesting       T6
 *   source_ready → failed         markFailed          T7
 *   ingesting    → ready          markReady           T8
 *   ingesting    → failed         markFailed          T9
 *   ready        → ready          markSourceDeleted   T10  (stamps only `source_deleted_at`)
 *
 * ⚠ `ready` IS NEVER OVERWRITTEN. `markFailed` carries `status <> 'ready'` precisely so a
 * late vendor error cannot un-publish a segment BAL-440 is already rendering.
 *
 * ⚠⚠ BAL-483 ADDS A SECOND, ORTHOGONAL SUB-LIFECYCLE ON THE SAME ROW — AND IT NEVER TOUCHES
 * `status`. The four `markTranscriptJob*` mutators below move only the four
 * `transcript_job_*` columns:
 *
 *   (none)    → submitted   markTranscriptJobSubmitted     B1   (CAS on submitted_at IS NULL;
 *                                                                 FIX ROUND 4 — also CLEARS a
 *                                                                 stale failure_reason left by an
 *                                                                 earlier markTranscriptJobSubmitFailed)
 *   (none)    → (none)      markTranscriptJobSubmitFailed  B1e  (FIX ROUND 3 — CAS on
 *                                                                 finished_at IS NULL; a
 *                                                                 PRE-submission failure, so it
 *                                                                 writes ONLY `failure_reason`
 *                                                                 and deliberately does NOT
 *                                                                 advance the ladder — see its
 *                                                                 own docblock for why stamping
 *                                                                 `finished_at` here would be a
 *                                                                 permanent dead end)
 *   submitted → finished    markTranscriptJobFinished      B2t  (CAS on finished_at IS NULL)
 *   submitted → finished    markTranscriptJobFailed        B2e  (same CAS, + a reason)
 *
 * A FAILED TRANSCRIPTION IS NOT A FAILED RECORDING. The recording is still playable, so
 * `status` / `failed_stage` / `failure_reason` are deliberately left alone by all four — a
 * Deepgram error must not un-publish a segment, nor break `markSourceDeleted`'s `status =
 * 'ready'` term. Conversely nothing in T1–T10 reads or writes the transcript columns, so the
 * two ladders can interleave in any order.
 *
 * ⚠ A WHERE CLAUSE MAY NAME AN ENUM LITERAL; AN INDEX PREDICATE MAY NOT. The columns-only
 * house rule (`meeting-files.ts`, `transcripts.ts`, `action-items.ts`) binds index
 * predicates and CHECKs only, because `ALTER TYPE … ADD VALUE` cannot be used in the same
 * migration transaction. Nothing constrains a plain `WHERE`, and every CAS below relies on
 * that.
 *
 * NO AUTHORIZATION LIVES HERE (ADR-1029) — and at BAL-473 nothing here was client-reachable
 * at all. Every caller was a signature-verified webhook or a BullMQ job on the admin `db`
 * client, which is also why a bare {@link meetingRecordingsRepository.findById} is
 * acceptable here where `meeting_files` deliberately refuses one.
 *
 * ⚠ AMENDED BY BAL-440 — ONE read is now reachable from a client request, and it is
 * {@link meetingRecordingsRepository.findInMeeting}, NOT `findById`. It takes the meeting as
 * a WHERE-clause term precisely because its `recordingId` arrives from the browser. That
 * changes nothing about authorization: the recap's gate still runs in `apps/web` BEFORE the
 * call, and this method is containment for the id, not a substitute for the gate.
 */
export const meetingRecordingsRepository = {
  /**
   * T1 — mint the segment row that IS the Daily `instanceId` and the Mux `passthrough`.
   * `status` falls to its column default (`'recording'`) and `capture_ended_at` stays NULL,
   * which is what TAKES the meeting's one capture slot.
   *
   * Returns `undefined` when `meeting_recording_capturing_idx` rejects the insert — i.e.
   * that meeting already has a capturing segment. ⚠ THAT IS A SUCCESSFUL NO-OP, NOT AN
   * ERROR: it is exactly the concurrent-duplicate `recording-ensure` case the AC requires
   * to lose, and the loser must not start a second Daily recording in the same room.
   *
   * ⚠⚠ THE CONFLICT IS ABSORBED BY `onConflictDoNothing`, NOT BY CATCHING A RAW `23505` —
   * and that difference is load-bearing, not stylistic. A raised `23505` ABORTS the ambient
   * transaction, so a caught one still leaves every later statement answering `25P02`
   * ("current transaction is aborted"). That is invisible in production, where the one
   * shipped caller (`recording-ensure`) has no ambient transaction — but the integration
   * harness wraps EVERY test in one, so the catch-shape made this repository untestable and
   * failed 10 cases in CI. `ON CONFLICT` never raises, so it is correct in both worlds.
   *
   * ⚠ The arbiter predicate MUST match `meeting_recording_capturing_idx` EXACTLY
   * (`capture_ended_at IS NULL AND deleted_at IS NULL`), or Postgres answers `42P10`
   * "no unique or exclusion constraint matching the ON CONFLICT specification". Both terms
   * are bare `isNull` column references and bind NO parameters — a partial-index arbiter
   * built from a value-carrying `eq()` fails `42P10` at runtime. Mirrors the
   * `transcriptsRepository.insertRaw` precedent against `transcript_capture_id_idx`.
   *
   * The signature still takes no `exec`: the one caller has no transaction to pass, and the
   * standalone contract keeps the Daily REST call out of any open transaction.
   *
   * ⚠ A `23503` (unknown `meetingId`) still propagates RAW, deliberately: a job enqueued
   * for a meeting that does not exist is a bug in the caller, not a race to swallow.
   */
  async insertCapturing(
    input: InsertCapturingRecordingInput
  ): Promise<MeetingRecording | undefined> {
    const [row] = await db
      .insert(meetingRecordings)
      .values({ meetingId: input.meetingId })
      .onConflictDoNothing({
        target: meetingRecordings.meetingId, // arbiter = meeting_recording_capturing_idx
        where: and(isNull(meetingRecordings.captureEndedAt), isNull(meetingRecordings.deletedAt)), // predicate MUST match the partial index exactly
      })
      .returning();
    return row;
  },

  /**
   * ONE live segment by id.
   *
   * ⚠ A BARE `findById` **IS** ACCEPTABLE HERE, unlike `meeting_files` — and the difference
   * is worth stating so neither rule is cargo-culted onto the other. `meeting_files` refuses
   * one because a `fileId` arrives from a user request and an unscoped read would be an
   * IDOR. Here the id arrives ONLY from a vendor payload we ourselves minted (`instance_id`
   * / `passthrough`) or from a BullMQ job body, and the resolving webhook has no `meetingId`
   * to scope by anyway.
   *
   * ⚠ THE CLIENT-REACHABLE CALLER THIS DOCBLOCK ANTICIPATED NOW EXISTS, AND IT DOES NOT CALL
   * THIS. BAL-440's recap playback mint reads through
   * {@link meetingRecordingsRepository.findInMeeting} — scoped by the gate's meeting id — and
   * projects through `toMeetingRecordingView` at the web boundary, exactly as reserved. Keep
   * it that way: a browser-supplied `recordingId` must never reach `findById`.
   */
  async findById(id: string, exec: DbExecutor = db): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .select()
      .from(meetingRecordings)
      .where(and(eq(meetingRecordings.id, id), isNull(meetingRecordings.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * ONE live segment, SCOPED BY MEETING — the shape {@link meetingRecordingsRepository.findById}'s
   * docblock reserved for the first client-reachable caller (BAL-440's playback mint).
   *
   * ⚠ THE MEETING IS IN THE WHERE CLAUSE, AND THAT IS THE WHOLE IDOR STORY FOR `recordingId`.
   * A foreign id, a soft-deleted one and an id that never existed all resolve identically to
   * `undefined`, so probing learns nothing about which uuids exist. The caller MUST pass the
   * GATE'S meeting id, never the parsed request input — passing the latter would scope the
   * read to the attacker's own claim and contain nothing.
   *
   * ⚠ NOT `listByMeeting(...).find(...)`. That would depend silently on
   * {@link MEETING_RECORDING_LIST_LIMIT} — a 51st segment would be unplayable — and would pull
   * every row's `mux_asset_id` into memory to return one. The containment was never the array
   * scan; it is the `meeting_id` term.
   *
   * ⚠ RETURNS THE FULL ROW, including `mux_asset_id` and `failure_reason`. That is correct at
   * this layer and the caller's obligation at its own boundary: `toMeetingRecordingView`
   * (`@balo/shared/meetings`) is the concealment boundary, and nothing here may hand a row
   * straight to a client.
   *
   * Served by the primary key; `meeting_id` and `deleted_at` are filters on the single matched
   * row, so NO new index is required.
   */
  async findInMeeting(
    input: FindMeetingRecordingInput,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .select()
      .from(meetingRecordings)
      .where(
        and(
          eq(meetingRecordings.id, input.recordingId),
          eq(meetingRecordings.meetingId, input.meetingId),
          isNull(meetingRecordings.deletedAt)
        )
      )
      .limit(1);
    return row;
  },

  /**
   * The meeting's CAPTURING segment, if it has one — the ensure job's "is one already
   * running?" gate and the `ready-to-download` / `recording.error` room-fallback target.
   *
   * At most one by construction: `capture_ended_at IS NULL AND deleted_at IS NULL` is
   * exactly `meeting_recording_capturing_idx`'s predicate, which is UNIQUE on `meeting_id`.
   * The query rides that index.
   *
   * ⚠ PREDICATED ON THE TIMESTAMP, NOT ON `status`. Those agree today (the
   * `meeting_recording_capture_slot` CHECK forces an unsettled slot to be a `recording`
   * row), but the timestamp is the authority — it is what the unique index reads.
   */
  async findCapturingForMeeting(
    meetingId: string,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .select()
      .from(meetingRecordings)
      .where(
        and(
          eq(meetingRecordings.meetingId, meetingId),
          isNull(meetingRecordings.captureEndedAt),
          isNull(meetingRecordings.deletedAt)
        )
      )
      .limit(1);
    return row;
  },

  /**
   * The live segment carrying a Daily recording id — the `recording.ready-to-download` and
   * `recording.error` PRIMARY lookup. Rides `meeting_recording_daily_id_idx`.
   */
  async findByDailyRecordingId(
    dailyRecordingId: string,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .select()
      .from(meetingRecordings)
      .where(
        and(
          eq(meetingRecordings.dailyRecordingId, dailyRecordingId),
          isNull(meetingRecordings.deletedAt)
        )
      )
      .limit(1);
    return row;
  },

  /**
   * The live segment carrying a Mux asset id — the Mux webhook's FALLBACK lookup, used when
   * a delivery carries no usable `passthrough`. Rides `meeting_recording_mux_asset_idx`.
   */
  async findByMuxAssetId(
    muxAssetId: string,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .select()
      .from(meetingRecordings)
      .where(and(eq(meetingRecordings.muxAssetId, muxAssetId), isNull(meetingRecordings.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * BAL-483 — the live segment carrying a Daily batch-processor job id. The
   * `batch-processor.job-finished` / `.error` PRIMARY lookup. Rides
   * `meeting_recording_transcript_job_idx`.
   *
   * ⚠ THE PRIMARY, NOT A FALLBACK — and that inversion is the whole point of stamping the job
   * id at submit. Neither batch webhook carries a room name, an instance id or a session id,
   * so `payload.id` is the ONLY handle that resolves without inference. The
   * `daily_recording_id` route ({@link meetingRecordingsRepository.findByDailyRecordingId})
   * is the fallback, and its caller must additionally refuse a row whose `transcript_job_id`
   * names a DIFFERENT job.
   */
  async findByTranscriptJobId(
    transcriptJobId: string,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .select()
      .from(meetingRecordings)
      .where(
        and(
          eq(meetingRecordings.transcriptJobId, transcriptJobId),
          isNull(meetingRecordings.deletedAt)
        )
      )
      .limit(1);
    return row;
  },

  /**
   * ⚠⚠ FIX ROUND 2 (R2) — the circuit breaker's ONLY read. Counts a meeting's LIVE `failed`
   * segments at one `failed_stage`. `recording-capture.ts`'s `handleEnsure` calls this BEFORE
   * `insertCapturing` and refuses to arm a fresh capture past
   * `MAX_DAILY_FAILURES_PER_MEETING` — see that constant's docblock for why: the Daily webhook
   * unconditionally re-arms `enqueueRecordingEnsure` after every `recording.error`, so a room
   * that refuses to record (R1's gap: `enable_recording` never reconciled onto it) would
   * otherwise loop for the rest of the meeting. Standalone read → the base `db`.
   */
  async countFailedByStage(
    meetingId: string,
    stage: string,
    exec: DbExecutor = db
  ): Promise<number> {
    const [row] = await exec
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(meetingRecordings)
      .where(
        and(
          eq(meetingRecordings.meetingId, meetingId),
          eq(meetingRecordings.status, 'failed'),
          eq(meetingRecordings.failedStage, stage),
          isNull(meetingRecordings.deletedAt)
        )
      );
    return row?.count ?? 0;
  },

  /**
   * A meeting's live segments in START ORDER (D2 — a meeting has 1:n segments, and BAL-440
   * renders them in the order they were captured). Served by
   * `meeting_recording_meeting_idx (meeting_id, created_at) WHERE deleted_at IS NULL`.
   *
   * ⚠ ORDERED BY `created_at`, NOT `started_at`. `started_at` is NULL until Daily's
   * `recording.started` lands (and stays NULL forever if that delivery is dropped, since
   * `markSourceReady` only backfills it when the payload carries one), so ordering by it
   * would put a segment's position at the mercy of a webhook. `created_at` is stamped by us
   * at insert, is NOT NULL, and is the index's second column.
   *
   * ⚠ BOUNDED AT {@link MEETING_RECORDING_LIST_LIMIT} — a cap, not pagination.
   */
  async listByMeeting(meetingId: string, exec: DbExecutor = db): Promise<MeetingRecording[]> {
    return exec
      .select()
      .from(meetingRecordings)
      .where(and(eq(meetingRecordings.meetingId, meetingId), isNull(meetingRecordings.deletedAt)))
      .orderBy(asc(meetingRecordings.createdAt))
      .limit(MEETING_RECORDING_LIST_LIMIT);
  },

  /**
   * T2 — Daily `recording.started`, resolved by `payload.instance_id`. Stamps the vendor id
   * and the vendor's capture-start instant. THE STATUS DOES NOT MOVE: the segment was
   * already `recording` the moment we inserted it.
   *
   * CAS: `id = $ AND deleted_at IS NULL AND status = 'recording' AND daily_recording_id IS NULL`.
   *
   * `undefined` means one of three harmless things, and the caller distinguishes them by
   * re-reading if it cares:
   *   · the row already carries a `daily_recording_id` — a REPLAYED delivery;
   *   · the row is no longer `recording` — `ready-to-download` overtook `started`, which is
   *     legal and costs nothing (`markSourceReady` backfills both columns via COALESCE);
   *   · the row is `failed` — ⚠ THE T5 CASE, AND IT IS DELIBERATELY REFUSED. A `failed` row
   *     has `capture_ended_at` stamped; reviving it to `recording` would put a capturing row
   *     OUTSIDE the capture slot and let a second Daily recording start in parallel. The
   *     caller logs at `error` (an unattached Daily recording now exists; it auto-stops on
   *     `minIdleTimeOut`). Known residual, documented not fixed — plan §5.1a.
   */
  async markStarted(
    input: MarkRecordingStartedInput,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .update(meetingRecordings)
      .set({ dailyRecordingId: input.dailyRecordingId, startedAt: input.startedAt })
      .where(
        and(
          eq(meetingRecordings.id, input.id),
          isNull(meetingRecordings.deletedAt),
          eq(meetingRecordings.status, 'recording'),
          isNull(meetingRecordings.dailyRecordingId)
        )
      )
      .returning();
    return row;
  },

  /**
   * T3 — Daily `recording.ready-to-download`. THE CAPTURE SLOT IS RELEASED HERE: stamping
   * `capture_ended_at` is what lets the next `recording-ensure` for this meeting insert a
   * fresh segment, which is the whole 1:n rejoin story (D2).
   *
   * CAS: `id = $ AND deleted_at IS NULL AND status = 'recording'`.
   *
   * ⚠ `dailyRecordingId` AND `startedAt` ARE COALESCED, NOT OVERWRITTEN. When the row was
   * resolved by the room-name FALLBACK (a dropped `recording.started`), the payload's
   * `recording_id` is the first id this row has ever seen and must be recorded. When
   * `recording.started` DID land, the row already knows both and the incumbent values win —
   * they came from the earlier, more authoritative event. Expressed by omitting the key
   * entirely when the caller supplies nothing, so no NULL parameter ever reaches a
   * `coalesce` (which would need a cast to be type-resolvable).
   *
   * ⚠ REQUIRES AN EXECUTOR. This runs inside the webhook's ONE transaction alongside the
   * marker insert and `markProcessed`; a caller that passed the base client by omission
   * would commit the effect outside the marker's transaction and break the idempotency
   * guarantee. The `dailyWebhookEventsRepository` asymmetry, restated.
   */
  async markSourceReady(
    input: MarkRecordingSourceReadyInput,
    exec: DbExecutor
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .update(meetingRecordings)
      .set({
        status: 'source_ready',
        captureEndedAt: input.at,
        durationSeconds: input.durationSeconds ?? null,
        ...(input.dailyRecordingId == null
          ? {}
          : {
              dailyRecordingId: sql`coalesce(${meetingRecordings.dailyRecordingId}, ${input.dailyRecordingId})`,
            }),
        ...(input.startedAt == null
          ? {}
          : {
              startedAt: sql`coalesce(${meetingRecordings.startedAt}, ${input.startedAt.toISOString()}::timestamptz)`,
            }),
      })
      .where(
        and(
          eq(meetingRecordings.id, input.id),
          isNull(meetingRecordings.deletedAt),
          eq(meetingRecordings.status, 'recording')
        )
      )
      .returning();
    return row;
  },

  /**
   * T6 — `recording-ingest` created the Mux asset. Stamps the asset id and moves to
   * `ingesting`; the segment now waits on `video.asset.ready`.
   *
   * CAS: `id = $ AND deleted_at IS NULL AND status = 'source_ready' AND mux_asset_id IS NULL`.
   *
   * ⚠ THE `mux_asset_id IS NULL` TERM IS THE ORPHAN GUARD. If it matches zero rows AFTER a
   * successful `assets.create`, a Mux asset now exists that this row will never point at —
   * the caller MUST log the asset id at `error` so it can be reconciled or deleted by hand.
   * Silently dropping it would leak billable Mux storage with no trace.
   */
  async markIngesting(
    input: MarkRecordingIngestingInput,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .update(meetingRecordings)
      .set({ status: 'ingesting', muxAssetId: input.muxAssetId })
      .where(
        and(
          eq(meetingRecordings.id, input.id),
          isNull(meetingRecordings.deletedAt),
          eq(meetingRecordings.status, 'source_ready'),
          isNull(meetingRecordings.muxAssetId)
        )
      )
      .returning();
    return row;
  },

  /**
   * T8 — Mux `video.asset.ready`. TERMINAL SUCCESS: the segment is playable.
   *
   * CAS: `id = $ AND deleted_at IS NULL AND status = 'ingesting' AND mux_asset_id = $`.
   *
   * ⚠⚠ FIX ROUND 2 (R3) — THE `mux_asset_id` TERM CLOSES A TWO-ASSET HAZARD, MIRRORING
   * `markIngesting`'s ORPHAN GUARD. If a worker dies between `assets.create` and
   * `markIngesting` committing, the row's `mux_asset_id` stays NULL, so the retry's own no-op
   * guard (`row.muxAssetId !== null` in `recording-ingest.ts`) does not fire and it creates a
   * SECOND asset. Both carry the SAME `passthrough` (the row id). Without this term, asset
   * #1's `video.asset.ready` would resolve by `passthrough` and stamp asset #1's playback id
   * onto a row whose `mux_asset_id` is asset #2 — a row that now describes TWO DIFFERENT
   * assets, with asset #2 an untracked orphan at Mux nothing will ever delete. CAS'ing on the
   * asset id the EVENT is actually about makes that mismatch a refused zero-row update instead
   * of a silent misattachment; the caller must log both ids at `error` when it detects one
   * (that is the orphan signal ops needs; see `routes/mux/webhook.ts`).
   *
   * ⚠ MUX'S DURATION WINS, WHEN IT SENDS ONE. On a `ready` row `duration_seconds` describes
   * the PLAYABLE artefact — what BAL-440 renders beside the player — not the pre-transcode
   * Daily source. When Mux sends none the incumbent (Daily's) value is left in place, which
   * is the `COALESCE($new, duration_seconds)` the plan specifies, expressed by omitting the
   * key.
   *
   * ⚠ REQUIRES AN EXECUTOR — the Mux webhook transaction. See `markSourceReady`.
   */
  async markReady(
    input: MarkRecordingReadyInput,
    exec: DbExecutor
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .update(meetingRecordings)
      .set({
        status: 'ready',
        muxPlaybackId: input.muxPlaybackId,
        readyAt: input.at,
        ...(input.durationSeconds == null ? {} : { durationSeconds: input.durationSeconds }),
      })
      .where(
        and(
          eq(meetingRecordings.id, input.id),
          isNull(meetingRecordings.deletedAt),
          eq(meetingRecordings.status, 'ingesting'),
          eq(meetingRecordings.muxAssetId, input.muxAssetId)
        )
      )
      .returning();
    return row;
  },

  /**
   * T4 / T5 / T7 / T9 — TERMINAL FAILURE, from any non-`ready` state.
   *
   * CAS: `id = $ AND deleted_at IS NULL AND status <> 'ready'`.
   *
   * ⚠⚠ `ready` IS NEVER OVERWRITTEN, AND THAT IS THE POINT OF THE `<>` RATHER THAN AN
   * enumeration of the three legal sources. A late `recording.error` or `video.asset.errored`
   * arriving after a segment went `ready` must not un-publish something BAL-440 is already
   * rendering. Returning `undefined` there is the correct, silent refusal.
   *
   * ⚠ `capture_ended_at` IS COALESCED, NOT OVERWRITTEN — and stamping it AT ALL is
   * load-bearing. A T5 failure (the ensure job's own start call failed) happens while
   * `capture_ended_at` is still NULL, so the row is holding its meeting's capture slot; if
   * this did not release it, EVERY subsequent `recording-ensure` for that meeting — including
   * the BullMQ retry of the very job that just failed — would find a capturing row and no-op,
   * and the meeting would silently never record (plan §5.1b). A T7/T9 failure already has the
   * slot released and keeps its original release instant.
   *
   * ⚠ `reason` IS TRUNCATED HERE, NOT BY THE CALLER. Every caller is handing over a vendor
   * error body; the cap belongs at the single write point so no caller can forget it. Sliced
   * in JS rather than via SQL `left()` — the two differ only for astral-plane text well past
   * the 500th character, and this keeps the statement Drizzle-native.
   *
   * ⚠⚠ BAL-480 FIX ROUND 1 — `onlyIfUnacknowledged` ADDS `daily_recording_id IS NULL` TO THE
   * CAS, and only when the caller asks for it. See {@link MarkRecordingFailedInput} for the
   * double-billing TOCTOU it closes for the stuck-slot reaper, and for why it must stay opt-in.
   */
  // ⚠ `${...toISOString()}::timestamptz` — NOT a bare Date. A Date interpolated into a raw
  // `sql` template is bound WITHOUT the column's timestamptz mapper, so postgres-js receives
  // it in `bytes.str` and throws "the string argument must be of type string ... received an
  // instance of Date". Only raw templates are affected; `.set({ captureEndedAt: date })`
  // elsewhere in this file is mapped normally and is correct as written.
  async markFailed(
    input: MarkRecordingFailedInput,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .update(meetingRecordings)
      .set({
        status: 'failed',
        failedStage: input.stage,
        failureReason: input.reason.slice(0, FAILURE_REASON_MAX_LENGTH),
        captureEndedAt: sql`coalesce(${meetingRecordings.captureEndedAt}, ${input.at.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(meetingRecordings.id, input.id),
          isNull(meetingRecordings.deletedAt),
          ne(meetingRecordings.status, 'ready'),
          // ⚠⚠ FIX ROUND 1 (F10) — ALSO REFUSES `failed → failed`. Without this, a SECOND
          // vendor error on an already-failed row overwrote `failed_stage`/`failure_reason`,
          // losing the FIRST failure's root cause — the one a runbook or a dispute would need.
          // First failure wins; `captureEndedAt`'s COALESCE already protects the release
          // instant the same way.
          ne(meetingRecordings.status, 'failed'),
          // ⚠⚠ BAL-480 — OPT-IN ONLY. `undefined` is dropped by `and()`, so an absent flag
          // emits no term and leaves every pre-existing caller's CAS byte-for-byte unchanged.
          input.onlyIfUnacknowledged === true
            ? isNull(meetingRecordings.dailyRecordingId)
            : undefined
        )
      )
      .returning();
    return row;
  },

  /**
   * T10 — `recording-cleanup-source` removed the Daily copy (or found it already gone, which
   * OD-7 makes the same answer). STAMPS ONLY `source_deleted_at`; THE STATUS DOES NOT MOVE.
   *
   * CAS: `id = $ AND deleted_at IS NULL AND status = 'ready' AND source_deleted_at IS NULL`.
   *
   * ⚠⚠ THE `status = 'ready'` TERM **IS** DECISION D4, EXPRESSED IN SQL — it is not a
   * defensive extra. The Daily source is the ONLY thing a failed Mux ingest can retry from,
   * so deleting it before the Mux asset is confirmed playable would make a recoverable
   * failure permanent. A caller that reaches this on a non-`ready` row has a bug and must log
   * at `error`, not retry.
   *
   * The `source_deleted_at IS NULL` term makes a replayed cleanup a no-op that preserves the
   * ORIGINAL deletion instant.
   */
  async markSourceDeleted(
    input: MarkRecordingSourceDeletedInput,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .update(meetingRecordings)
      .set({ sourceDeletedAt: input.at })
      .where(
        and(
          eq(meetingRecordings.id, input.id),
          isNull(meetingRecordings.deletedAt),
          eq(meetingRecordings.status, 'ready'),
          isNull(meetingRecordings.sourceDeletedAt)
        )
      )
      .returning();
    return row;
  },

  /**
   * B1 (BAL-483) — CLAIM THIS SEGMENT'S ONE TRANSCRIPTION SUBMISSION, stamping the job id
   * Daily returned synchronously from `POST /batch-processor`.
   *
   * CAS: `id = $ AND deleted_at IS NULL AND transcript_job_submitted_at IS NULL`.
   *
   * ⚠⚠ `undefined` IS A SUCCESSFUL NO-OP, NOT AN ERROR — the house rule, restated because the
   * consequence here is vendor spend. A retried or concurrent submit job that loses this CAS
   * has ALREADY CREATED a batch job at Daily; the caller must log that job id at `error` as an
   * ORPHAN (nothing points at it) exactly as `recording-ingest` logs an orphaned Mux asset. It
   * must NOT retry and must NOT raise.
   *
   * ⚠ THE PREDICATE IS THE TIMESTAMP, NOT THE JOB ID. `transcript_job_submitted_at IS NULL` is
   * total; `transcript_job_id IS NULL` would be equivalent only while the
   * `meeting_recording_transcript_job_submitted` CHECK holds, and predicating on the CHECK's
   * consequence rather than on the column we actually write is how those two drift apart.
   *
   * ⚠ IT DOES NOT TOUCH `status`. Transcription is an ORTHOGONAL sub-lifecycle riding the same
   * row — see the repository docblock. A `source_ready`, `ingesting` or `ready` segment may all
   * legitimately be submitted, so there is deliberately no `status` term.
   *
   * ⚠ NO `status` GUARD MEANS NO PROTECTION AGAINST SUBMITTING A `failed` SEGMENT EITHER — that
   * is the caller's gate (`transcript-capture`'s submit handler checks `daily_recording_id` and
   * `source_deleted_at` before it ever calls Daily), and it belongs there because only the
   * caller knows whether the Daily artefact still exists.
   *
   * ⚠⚠ FIX ROUND 4 — ALSO CLEARS A STALE `failure_reason`. {@link markTranscriptJobSubmitFailed}
   * (B1e) can stamp `transcript_job_failure_reason` while leaving `submitted_at` NULL — a
   * `batch_submit`-stage terminal give-up with no vendor job ever recorded. A LATER manual
   * re-submit that reaches this CAS is a fresh attempt that just succeeded, and without this the
   * row would read as BOTH a success (`submitted_at`/`transcript_job_id` freshly set) AND a
   * failure (the EARLIER `failure_reason` still sitting on the row) — indistinguishable from a
   * genuine `batch-processor.error` on the new job, which defeats the exact ops queries B1e's own
   * docblock and DOOR 1 (`recording-cleanup-source.ts`) depend on. A fresh submit supersedes any
   * earlier pre-submission failure.
   */
  async markTranscriptJobSubmitted(
    input: MarkTranscriptJobSubmittedInput,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .update(meetingRecordings)
      .set({
        transcriptJobId: input.transcriptJobId,
        transcriptJobSubmittedAt: input.at,
        transcriptJobFailureReason: null,
      })
      .where(
        and(
          eq(meetingRecordings.id, input.id),
          isNull(meetingRecordings.deletedAt),
          isNull(meetingRecordings.transcriptJobSubmittedAt)
        )
      )
      .returning();
    return row;
  },

  /**
   * B1e (BAL-483 FIX ROUND 3) — RECORD A PRE-SUBMISSION FAILURE WITHOUT CLAIMING A TERMINAL
   * VENDOR STATE. Called when the `transcript-capture` submit job (`handleSubmit`) exhausts
   * its retries at the `batch_submit` stage: no vendor job was ever created (the `POST
   * /batch-processor` call is what failed), or — the rare accepted-window race
   * `handleSubmit`'s own docblock names — one WAS created but `markTranscriptJobSubmitted`
   * never recorded it before every retry also failed.
   *
   * CAS: `id = $ AND deleted_at IS NULL AND transcript_job_finished_at IS NULL`.
   *
   * ⚠⚠ WRITES `failure_reason` ONLY. IT DOES NOT TOUCH `transcript_job_finished_at` — and that
   * omission IS the fix. {@link meetingRecordingsRepository.markTranscriptJobFailed}
   * unconditionally stamps `finished_at`, which is correct once a vendor job genuinely exists
   * and has reached a terminal state, but WRONG here: `transcript_job_submitted_at` is still
   * NULL on this row, so stamping `finished_at` would assert a terminal vendor state that never
   * happened. That lie used to poison the row permanently:
   *   1. `recording-cleanup-source`'s withhold gate (`submitted_at IS NOT NULL AND finished_at
   *      IS NULL`) could never hold for this row again.
   *   2. Worse — a later MANUAL re-submit would stamp `submitted_at`, but when the real
   *      `batch-processor.job-finished` webhook then arrived,
   *      {@link meetingRecordingsRepository.markTranscriptJobFinished}'s CAS
   *      (`isNull(transcriptJobFinishedAt)`) would NO-OP against the already-terminal row —
   *      `recordingTransitioned: false` — so NO ingest was ever enqueued and the transcript
   *      was silently lost forever. This mutator exists to close exactly that dead end.
   *   3. It also defeated the `daily_recording_id` fallback in `resolveBatchRecordingRow`
   *      (`routes/daily/webhook.ts`) once retries exhausted — a row already marked terminal no
   *      longer reads as a live, in-flight submit.
   * Leaving `finished_at` NULL keeps the row exactly where a genuine future submit attempt or
   * webhook expects to find it — still able to reach `finished_at` for the first and only time.
   *
   * `undefined` means the row already reached a terminal state (a genuine `job-finished` or
   * `.error` beat this write, or a replay) — a successful no-op, not an error. The caller
   * logs/acks; it does not retry.
   *
   * ⚠ `reason` IS TRUNCATED HERE, NOT BY THE CALLER — the single-write-point discipline every
   * sibling in this family follows.
   */
  async markTranscriptJobSubmitFailed(
    input: MarkTranscriptJobSubmitFailedInput,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .update(meetingRecordings)
      .set({ transcriptJobFailureReason: input.reason.slice(0, FAILURE_REASON_MAX_LENGTH) })
      .where(
        and(
          eq(meetingRecordings.id, input.id),
          isNull(meetingRecordings.deletedAt),
          isNull(meetingRecordings.transcriptJobFinishedAt)
        )
      )
      .returning();
    return row;
  },

  /**
   * B2t (BAL-483) — TERMINAL SUCCESS for the batch job (`batch-processor.job-finished`).
   *
   * CAS: `id = $ AND deleted_at IS NULL AND transcript_job_finished_at IS NULL`.
   *
   * ⚠⚠ STAMPING THIS IS WHAT RELEASES `recording-cleanup-source`. The batch processor
   * DOWNLOADS the Daily recording while it runs, so cleanup is withheld for exactly the window
   * `transcript_job_submitted_at IS NOT NULL AND transcript_job_finished_at IS NULL`. Both
   * terminal arms — this one and {@link meetingRecordingsRepository.markTranscriptJobFailed} —
   * must stamp it, or the Daily source leaks forever.
   *
   * ⚠ IT DOES NOT TOUCH `status` / `failed_stage` / `failure_reason`. A recording's own
   * lifecycle is not a transcription's; see the repository docblock.
   *
   * `undefined` = a replayed delivery (or an `error` that already terminated the job). The
   * caller logs at `info` and acks. FIRST TERMINAL WINS, exactly like `markFailed`.
   */
  async markTranscriptJobFinished(
    input: MarkTranscriptJobFinishedInput,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .update(meetingRecordings)
      .set({ transcriptJobFinishedAt: input.at })
      .where(
        and(
          eq(meetingRecordings.id, input.id),
          isNull(meetingRecordings.deletedAt),
          isNull(meetingRecordings.transcriptJobFinishedAt)
        )
      )
      .returning();
    return row;
  },

  /**
   * B2e (BAL-483) — TERMINAL FAILURE for the batch job (`batch-processor.error`).
   *
   * CAS: `id = $ AND deleted_at IS NULL AND transcript_job_finished_at IS NULL`.
   *
   * ⚠⚠ IT STAMPS `transcript_job_finished_at` TOO. Terminal is terminal, and that column — not
   * a success flag — is what releases the `recording-cleanup-source` withhold. A failure arm
   * that stamped only the reason would leak the Daily source for every failed job, which is
   * precisely the population most likely to fail.
   *
   * ⚠⚠ IT DOES NOT TOUCH `status`, `failed_stage` OR `failure_reason`. A failed TRANSCRIPTION
   * is NOT a failed RECORDING: the segment is still playable, BAL-440 still renders it, and
   * `markSourceDeleted`'s `status = 'ready'` term must keep matching. Writing the recording's
   * own failure columns here would un-publish a healthy recording over a Deepgram error.
   *
   * ⚠ `reason` IS TRUNCATED HERE, NOT BY THE CALLER — {@link markFailed}'s discipline, same
   * cap, same single write point. Sliced in JS rather than via SQL `left()`.
   *
   * `undefined` = the job already reached a terminal state (a replay, or a `job-finished` that
   * beat this `error`). FIRST TERMINAL WINS.
   */
  async markTranscriptJobFailed(
    input: MarkTranscriptJobFailedInput,
    exec: DbExecutor = db
  ): Promise<MeetingRecording | undefined> {
    const [row] = await exec
      .update(meetingRecordings)
      .set({
        transcriptJobFinishedAt: input.at,
        transcriptJobFailureReason: input.reason.slice(0, FAILURE_REASON_MAX_LENGTH),
      })
      .where(
        and(
          eq(meetingRecordings.id, input.id),
          isNull(meetingRecordings.deletedAt),
          isNull(meetingRecordings.transcriptJobFinishedAt)
        )
      )
      .returning();
    return row;
  },

  /**
   * Soft-delete ONE segment. Returns the stamped row, or `undefined` when the id names no
   * live segment.
   *
   * ⚠ AN OPS ESCAPE HATCH WITH **NO PRODUCTION CALLER IN THIS PR**, and it exists for one
   * named situation: a row STUCK at `recording` because Daily sent neither
   * `ready-to-download` nor `recording.error`. Such a row holds its meeting's capture slot
   * forever and there is deliberately NO RETENTION reaper (a retention sweep is out of scope
   * and needs its own ruling), so soft-deleting it by hand is how the slot is freed. ⚠ BAL-480's
   * stuck-slot reaper is a DIFFERENT, narrower thing — see the note below. Both partial
   * uniques carry `deleted_at IS NULL`, so this also vacates the row's `daily_recording_id`
   * and `mux_asset_id` for reuse.
   *
   * ⚠ IT DELETES NO VENDOR ARTEFACT. The Daily source and the Mux asset both survive this;
   * removing them is out of scope, exactly as `meetingFilesRepository.softDelete` leaves its
   * R2 object to a separate, caller-owned step.
   *
   * ⚠ BAL-480 — since the stuck-slot reaper shipped, this is no longer the routine remedy for
   * the F8 residual (`recording-capture.ts`'s `handleEnsure` reaps that automatically); it
   * remains the remedy for the two residuals BAL-480 does not close (schema docblock). Still no
   * production caller — do not add one here.
   */
  async softDelete(input: { id: string }): Promise<MeetingRecording | undefined> {
    const [row] = await db
      .update(meetingRecordings)
      .set({ deletedAt: new Date() })
      .where(and(eq(meetingRecordings.id, input.id), isNull(meetingRecordings.deletedAt)))
      .returning();
    return row;
  },
};
