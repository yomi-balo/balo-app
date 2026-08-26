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
}

/** {@link meetingRecordingsRepository.markSourceDeleted} — T10, from `recording-cleanup-source`. */
export interface MarkRecordingSourceDeletedInput {
  id: string;
  at: Date;
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
 * ⚠ A WHERE CLAUSE MAY NAME AN ENUM LITERAL; AN INDEX PREDICATE MAY NOT. The columns-only
 * house rule (`meeting-files.ts`, `transcripts.ts`, `action-items.ts`) binds index
 * predicates and CHECKs only, because `ALTER TYPE … ADD VALUE` cannot be used in the same
 * migration transaction. Nothing constrains a plain `WHERE`, and every CAS below relies on
 * that.
 *
 * NO AUTHORIZATION LIVES HERE (ADR-1029) — and nothing in this PR is client-reachable at
 * all. Every caller is a signature-verified webhook or a BullMQ job on the admin `db`
 * client, which is also why a bare {@link meetingRecordingsRepository.findById} is
 * acceptable here where `meeting_files` deliberately refuses one.
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
   * / `passthrough`) or from a BullMQ job body, nothing in this PR is client-reachable, and
   * the resolving webhook has no `meetingId` to scope by anyway. If a client-reachable
   * caller ever appears, it projects through `toMeetingRecordingView` and scopes by meeting
   * — it does not call this.
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
          ne(meetingRecordings.status, 'failed')
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
   * Soft-delete ONE segment. Returns the stamped row, or `undefined` when the id names no
   * live segment.
   *
   * ⚠ AN OPS ESCAPE HATCH WITH **NO PRODUCTION CALLER IN THIS PR**, and it exists for one
   * named situation: a row STUCK at `recording` because Daily sent neither
   * `ready-to-download` nor `recording.error`. Such a row holds its meeting's capture slot
   * forever and there is deliberately NO reaper (a retention sweep is out of scope and needs
   * its own ruling), so soft-deleting it by hand is how the slot is freed. Both partial
   * uniques carry `deleted_at IS NULL`, so this also vacates the row's `daily_recording_id`
   * and `mux_asset_id` for reuse.
   *
   * ⚠ IT DELETES NO VENDOR ARTEFACT. The Daily source and the Mux asset both survive this;
   * removing them is out of scope, exactly as `meetingFilesRepository.softDelete` leaves its
   * R2 object to a separate, caller-owned step.
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
