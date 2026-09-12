import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  transcripts,
  meetings,
  type Transcript,
  type NewTranscript,
  type TranscriptVendor,
  type CanonicalTranscript,
  type ExtractedActionItem,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/** Compiles only while `T` is exactly `never` — the `engagement-capability-disjoint.ts` idiom. */
type AssertNever<T extends never> = T;

/**
 * BAL-550 (D5) — THE TYPE-LEVEL BRACE BEHIND {@link transcriptsRepository.claimRecapResume}.
 *
 * The ticket requires the recap re-drive to be STRUCTURALLY unable to touch a
 * `transcript_job_*` column — the BAL-483 batch-transcription state, which lives on
 * `meeting_recordings` and is NOT this re-drive's business. That is a COMPILER fact, not a
 * runtime check: `transcripts` has no such column, so `NewTranscript` has no such key, so
 * naming one in `claimRecapResume`'s `satisfies Partial<NewTranscript>` payload is a compile
 * error. These two aliases pin that fact so it cannot be quietly undone by adding the columns
 * to this table.
 *
 * ⚠⚠ WHICH GATE HOLDS THIS, AND WHY IT IS **NOT** IN A `*.test.ts`. `@balo/db` has NO
 * `typecheck` script (memory `reference_db_shared_no_typecheck_lint_scripts`), and vitest's
 * esbuild strips types WITHOUT checking them — so the same assertion in
 * `transcripts.redrive-type.test.ts` (where the plan placed it) would be VACUOUSLY GREEN
 * twice over. It lives in this module instead because `apps/api/src` imports
 * `transcriptsRepository`, and `apps/api`'s `tsc --noEmit` type-checks every file it reaches,
 * including this one. The plan's test file still ships — with the RUNTIME half (the real
 * `transcripts` column list), which is the part vitest can actually hold.
 *
 * ⚠ NON-VACUITY PROOF (under a minute): add
 * `transcriptJobFinishedAt: timestamp('transcript_job_finished_at', { withTimezone: true }),`
 * to `schema/transcripts.ts`, then run `pnpm --filter api typecheck` (api's task is
 * `typecheck`; web's is `check-types` — memory `reference_turbo_typecheck_task_is_check_types`).
 * It MUST fail with TS2344 on `_TranscriptsCarryNoTranscriptJobColumn` AND TS2578 "Unused
 * '@ts-expect-error' directive" below. Revert and it MUST pass again.
 */
export type _TranscriptsCarryNoTranscriptJobColumn = AssertNever<
  Extract<keyof NewTranscript, `transcriptJob${string}`>
>;

// @ts-expect-error — `transcript_job_*` lives on `meeting_recordings`, never on `transcripts`.
export type _TranscriptJobWriteIsUnrepresentable = Pick<NewTranscript, 'transcriptJobFinishedAt'>;

/**
 * Input for persisting the raw canonical transcript (pipeline stage "persist raw"). The
 * pipeline builds `canonical` in-memory via `normalizeVendorPayload`; `status`/`filler_words`
 * fall to their column defaults (`processing` / `true`). `captureId` is the stable dedup key
 * (partial-unique + BullMQ jobId basis).
 *
 * ⚠ `recordingRef` WAS REMOVED BY BAL-473 (D3), NOT MISLAID. It was a producer-less `text`
 * column standing in for "where the recording lives". Recordings now have a real anchor —
 * `meeting_recordings`, 1:n per meeting on `meetings.id` — so a single nullable string on
 * `transcripts` could only ever disagree with it. Resolve a meeting's recordings through
 * `meetingRecordingsRepository.listByMeeting`; do not re-add a reference column here.
 */
/**
 * The PROJECTED transcript reference the BAL-388 recap reads — id + status ONLY, never the
 * `canonical` jsonb. See {@link transcriptsRepository.findByMeetingId}.
 */
export type TranscriptStatusRef = Pick<Transcript, 'id' | 'status'>;

/**
 * The same projection as {@link TranscriptStatusRef} plus the `meeting_id` the caller keys on.
 * Returned by {@link transcriptsRepository.findByMeetingIds}, which answers for MANY meetings in
 * one round trip and therefore cannot rely on the caller remembering which id it asked about.
 */
export type TranscriptMeetingStatusRef = Pick<Transcript, 'id' | 'status' | 'meetingId'>;

/**
 * BAL-548 / ADR-1055 — one failed transcript, projected for the pending-actions queue. See
 * {@link transcriptsRepository.listFailedSince}.
 *
 * ⚠ EXPORTED EXPLICITLY. `TranscriptStatusRef`/`TranscriptMeetingStatusRef` above are NOT
 * re-exported from `repositories/index.ts`; this one is, because the sweep in `apps/api` has
 * to name it.
 *
 * ⚠ `meetingScheduledStart`, NOT a meeting title — `meetings` has no `title` column.
 */
export interface FailedTranscriptAlertRow {
  transcriptId: string;
  meetingId: string;
  meetingScheduledStart: Date;
  failedStage: string | null;
  failureReason: string | null;
  createdAt: Date;
}

export interface InsertRawTranscriptInput {
  captureId: string;
  engagementId: string;
  /** BAL-418: REQUIRED — `transcripts.meeting_id` is NOT NULL now (no longer a seam). */
  meetingId: string;
  vendor: TranscriptVendor;
  canonical: CanonicalTranscript;
  language?: string | null;
  durationMs?: number | null;
}

/**
 * `transcriptsRepository` (BAL-387) — the transcript envelope + raw canonical artifact. The
 * write methods are the pipeline's durable stage markers: `insertRaw` (idempotent persist),
 * `setExtractedActionItems` (summary-stage capture), and the `mark*` stage-completion stamps
 * that let a retried BullMQ job short-circuit each stage without re-spending LLM budget or
 * re-creating action items.
 */
export const transcriptsRepository = {
  /**
   * Persist the raw canonical transcript for a capture, EXACTLY ONCE. `onConflictDoNothing`
   * on the `capture_id` PARTIAL unique (arbiter predicate `deleted_at IS NULL` matches
   * `transcript_capture_id_idx`) — a first write returns the fresh row; a retried/duplicate
   * enqueue conflicts, DO NOTHING, and the existing row is re-read via `findByCaptureId`. One
   * `transcripts` row per capture across retries.
   */
  async insertRaw(input: InsertRawTranscriptInput): Promise<Transcript> {
    const [inserted] = await db
      .insert(transcripts)
      .values({
        captureId: input.captureId,
        engagementId: input.engagementId,
        meetingId: input.meetingId,
        vendor: input.vendor,
        canonical: input.canonical,
        language: input.language ?? null,
        durationMs: input.durationMs ?? null,
      })
      .onConflictDoNothing({
        target: transcripts.captureId, // arbiter = the PARTIAL unique index
        where: isNull(transcripts.deletedAt), // predicate MUST match the index exactly
      })
      .returning();

    if (inserted !== undefined) {
      return inserted;
    }

    // Conflict on the partial-unique — the transcript already exists for this capture.
    const existing = await this.findByCaptureId(input.captureId);
    if (existing === undefined) {
      throw new Error(
        `transcripts.insertRaw conflicted but no live transcript was found for capture ${input.captureId}`
      );
    }
    return existing;
  },

  /** The live transcript for a capture id, if any. Rides `transcript_capture_id_idx`. */
  async findByCaptureId(captureId: string): Promise<Transcript | undefined> {
    const [row] = await db
      .select()
      .from(transcripts)
      .where(and(eq(transcripts.captureId, captureId), isNull(transcripts.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * THE MEETING-SCOPED READ (BAL-388 recap). The live transcript for one meeting, or
   * `undefined`. Rides the partial index `transcript_meeting_idx` on `(meeting_id)
   * WHERE deleted_at IS NULL`.
   *
   * ⚠ AT MOST ONE ROW IS RETURNED, BUT NOTHING IN THE SCHEMA GUARANTEES UNIQUENESS.
   * `transcripts.capture_id` is the partial-unique, not `meeting_id`, so two captures of the
   * same meeting are representable. `.limit(1)` with a deterministic `created_at DESC, id DESC`
   * order therefore picks the MOST RECENT one rather than an arbitrary one — a recap that
   * flip-flopped between two summaries on refresh would read as a bug.
   *
   * ⚠⚠ PROJECTED TO TWO COLUMNS ON PURPOSE. `transcripts.canonical` holds the WHOLE raw segment
   * array for the call (and `extracted_action_items` the LLM extraction), so a bare `select()`
   * pulls a potentially multi-hundred-KB jsonb on EVERY recap render just to read one enum. The
   * only consumer needs exactly `id` (to find its artefacts) and `status` (to pick the artefact
   * render). Precedent: `credit-sessions.ts` `findForClientMoneyView`.
   */
  async findByMeetingId(meetingId: string): Promise<TranscriptStatusRef | undefined> {
    const [row] = await db
      .select({ id: transcripts.id, status: transcripts.status })
      .from(transcripts)
      .where(and(eq(transcripts.meetingId, meetingId), isNull(transcripts.deletedAt)))
      .orderBy(desc(transcripts.createdAt), desc(transcripts.id))
      .limit(1);
    return row;
  },

  /**
   * The SAME projection as {@link findByMeetingId}, for MANY meetings in ONE round trip.
   *
   * ⚠ EXISTS TO KILL AN N-QUERY FAN-OUT. The case surface renders every consultation on a
   * case at once, so calling `findByMeetingId` per row means a case with forty held
   * consultations issues forty queries on every render. Filtering to terminal meetings is
   * NOT a bound — a long-running case is precisely the one that has many of them.
   *
   * ⚠ AT MOST ONE ROW PER MEETING, newest first, mirroring `findByMeetingId`'s `limit(1)`.
   * A meeting can legitimately hold several transcript rows (a re-capture writes a new one),
   * so returning them all would leave the caller's per-meeting answer dependent on row
   * order. `DISTINCT ON` is avoided deliberately: Drizzle does not model it cleanly and the
   * de-dup below is trivial and explicit.
   *
   * An empty `meetingIds` short-circuits — `inArray` with an empty list is an error in some
   * drivers and a full scan in others, and neither is what a caller with no meetings meant.
   */
  async findByMeetingIds(
    meetingIds: readonly string[]
  ): Promise<Map<string, TranscriptMeetingStatusRef>> {
    const byMeetingId = new Map<string, TranscriptMeetingStatusRef>();
    if (meetingIds.length === 0) return byMeetingId;

    const rows = await db
      .select({
        id: transcripts.id,
        status: transcripts.status,
        meetingId: transcripts.meetingId,
      })
      .from(transcripts)
      .where(and(inArray(transcripts.meetingId, [...meetingIds]), isNull(transcripts.deletedAt)))
      .orderBy(desc(transcripts.createdAt), desc(transcripts.id));

    // First row wins: the ORDER BY is newest-first, so this reproduces the single-meeting
    // reader's `limit(1)` exactly rather than approximating it.
    for (const row of rows) {
      if (!byMeetingId.has(row.meetingId)) byMeetingId.set(row.meetingId, row);
    }
    return byMeetingId;
  },

  /**
   * ONE live transcript by id. `undefined` when missing or soft-deleted.
   *
   * ⚠ TAKES AN OPTIONAL EXECUTOR (defaulting to the base client — the
   * {@link meetingRecordingsRepository.findById} shape). BAL-550's re-drive pre-reads the row
   * INSIDE its one transaction, immediately before {@link transcriptsRepository.claimRecapResume}
   * NULLs `failed_stage` / `failure_reason`, so the `audit_events` row can record the prior
   * state that the CAS's `RETURNING` (a POST-update row) no longer carries. Passing the base
   * client there would read outside the transaction's snapshot.
   */
  async findById(id: string, exec: DbExecutor = db): Promise<Transcript | undefined> {
    const [row] = await exec
      .select()
      .from(transcripts)
      .where(and(eq(transcripts.id, id), isNull(transcripts.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * Capture the summary-stage extracted action items on the row (survives even if not
   * promoted to first-class action items). Called before `markActionItemsExtracted`.
   */
  async setExtractedActionItems(id: string, items: ExtractedActionItem[]): Promise<Transcript> {
    const [updated] = await db
      .update(transcripts)
      .set({ extractedActionItems: items })
      .where(eq(transcripts.id, id))
      .returning();
    if (updated === undefined) {
      throw new Error(`Failed to set extracted action items on transcript: ${id}`);
    }
    return updated;
  },

  /**
   * Stamp the `createFromExtraction` stage gate (`action_items_extracted_at = now`). Set once,
   * immediately after `createFromExtraction` commits (at-least-once) — a retried job then skips
   * extraction. Also stamped on the terminal `EngagementNotActiveError` skip so the job does
   * not retry forever.
   */
  async markActionItemsExtracted(id: string): Promise<Transcript> {
    const [updated] = await db
      .update(transcripts)
      .set({ actionItemsExtractedAt: new Date() })
      .where(eq(transcripts.id, id))
      .returning();
    if (updated === undefined) {
      throw new Error(`Failed to mark action items extracted on transcript: ${id}`);
    }
    return updated;
  },

  /**
   * Stamp the recap-publish stage gate (`recap_ready_published_at = now`) and flip `status`
   * to `ready`. Set once after `recap.ready` is published — a retried job then skips publish.
   */
  async markRecapPublished(id: string): Promise<Transcript> {
    const [updated] = await db
      .update(transcripts)
      .set({ recapReadyPublishedAt: new Date(), status: 'ready' })
      .where(eq(transcripts.id, id))
      .returning();
    if (updated === undefined) {
      throw new Error(`Failed to mark recap published on transcript: ${id}`);
    }
    return updated;
  },

  /**
   * Terminal failure stamp (called from `worker.on('failed')` on exhausted retries): records
   * the failing `stage` + `reason` and flips `status` to `failed`.
   */
  async markFailed(id: string, stage: string, reason: string): Promise<Transcript> {
    const [updated] = await db
      .update(transcripts)
      .set({ failedStage: stage, failureReason: reason, status: 'failed' })
      .where(eq(transcripts.id, id))
      .returning();
    if (updated === undefined) {
      throw new Error(`Failed to mark transcript failed: ${id}`);
    }
    return updated;
  },

  /**
   * Record a stage SKIP (degradation) on a path that still completes — distinct from
   * `markFailed`: it stamps `failed_stage`/`failure_reason` for observability (ADR-1030's
   * system-actor exemption is from attribution, not observability) but leaves `status`
   * UNCHANGED. Used by the pipeline's engagement-not-active terminal skip, where the recap
   * still publishes downstream (so the row ends `ready`, with the skip recorded). `updated_at`
   * auto-bumps via the column's `$onUpdate` hook.
   */
  async recordStageSkip(id: string, stage: string, reason: string): Promise<void> {
    const [updated] = await db
      .update(transcripts)
      .set({ failedStage: stage, failureReason: reason })
      .where(eq(transcripts.id, id))
      .returning();
    if (updated === undefined) {
      throw new Error(`Failed to record stage skip on transcript: ${id}`);
    }
  },

  /**
   * BAL-550 (D5) — CLAIM A FAILED RECAP FOR THE ADMIN RE-DRIVE. `failed → processing`.
   *
   * CAS: `id = $ AND deleted_at IS NULL AND status = 'failed' AND failed_stage IS NOT NULL
   *       AND EXISTS (live meeting)`.
   * SET: `status='processing'`, `failed_stage=NULL`, `failure_reason=NULL`.
   *
   * ⚠⚠ IT ALSO REQUIRES A LIVE MEETING. The `EXISTS` term is the row's SECOND soft-delete
   * filter and it guards a different table: the segment's own `deleted_at` says nothing about
   * the MEETING having been deleted underneath it. Such a row is never rendered — the page's
   * windowed read joins `meetings` with `deleted_at IS NULL` — so this closes a hand-crafted
   * request, the only way to reach it. It matters because a successful re-drive ends in
   * `stagePublishRecap` firing `recap.ready` to BOTH PARTIES: a user-visible notification
   * about a consultation the platform considers deleted.
   *
   * ⚠⚠ IT RESETS NO STAGE GATE, AND THAT IS THE WHOLE POINT. `transcript_artifacts`
   * (`cleaned`, `summary`), `extracted_action_items`, `action_items_extracted_at` and
   * `recap_ready_published_at` are ALL untouched, so BAL-387's per-stage gates still
   * short-circuit on the re-run: no LLM budget is re-spent, no action item is re-created, no
   * second `recap.ready` is published. "The pipeline converges on the row as it is" stays
   * literally true.
   *
   * ⚠ THE THREE COLUMNS IT DOES WRITE ARE THE CLAIM, NOT A RESET (plan §13 D5a). Three
   * reasons it is required rather than optional:
   *   1. the design reference puts the recap chip at `processing` immediately after confirm,
   *      which IS `transcripts.status = 'processing'`;
   *   2. without a CAS this kind has NO idempotency — the ticket's "a double-click produces
   *      ONE job" cannot hold, because the job id is derived from the audit row (D2) and two
   *      clicks would mint two audit rows and two genuinely distinct jobs;
   *   3. leaving `failed_stage` set would make a SUCCESSFUL re-run land on the PARTIAL
   *      predicate (`status='ready' AND failed_stage IS NOT NULL`) and render as
   *      "Ready · action items skipped" — the one conflation this lens forbids.
   * Precedent for clearing a stale reason on a fresh attempt:
   * `meetingRecordingsRepository.markTranscriptJobSubmitted`.
   *
   * ⚠ `failed_stage IS NOT NULL` IS NOT DECORATION. It is the second half of the partial-recap
   * discipline this file already states at {@link transcriptsRepository.listFailedSince}: the
   * read must carry BOTH terms or `transcript_failed_idx` (predicated on `failed_stage IS NOT
   * NULL` alone) is not provably a superset and the planner will not use it. Here it ALSO
   * refuses a row that is `failed` with no recorded stage — nothing to resume from.
   *
   * ⚠⚠ STRUCTURALLY UNABLE TO TOUCH `transcript_job_*`. Those four columns live on
   * `meeting_recordings`; this module imports only `transcripts` + `meetings` from the schema,
   * and the payload below is `satisfies Partial<NewTranscript>`, which HAS NO SUCH KEY —
   * naming one is a COMPILE ERROR, not a runtime check. Pinned by
   * {@link _TranscriptsCarryNoTranscriptJobColumn} above.
   *
   * `undefined` = not a resumable failed recap (already claimed, never failed, a PARTIAL
   * `ready` row, soft-deleted) ⇒ the caller answers `409 not_redrivable`, writes NO audit row
   * and enqueues NO job.
   *
   * ⚠ REQUIRES AN EXECUTOR — it runs inside the re-drive route's ONE transaction alongside the
   * `audit_events` insert. It is the ONE mutator in this repository that takes one:
   * the BAL-387 pipeline writers are single-statement stage stamps with no row to pair with,
   * while this write is meaningless without the audit row committed beside it.
   */
  async claimRecapResume(id: string, exec: DbExecutor): Promise<Transcript | undefined> {
    const claim = {
      status: 'processing',
      failedStage: null,
      failureReason: null,
    } satisfies Partial<NewTranscript>;

    const [updated] = await exec
      .update(transcripts)
      .set(claim)
      .where(
        and(
          eq(transcripts.id, id),
          isNull(transcripts.deletedAt),
          eq(transcripts.status, 'failed'),
          isNotNull(transcripts.failedStage),
          exists(
            db
              .select({ one: sql`1` })
              .from(meetings)
              .where(and(eq(meetings.id, transcripts.meetingId), isNull(meetings.deletedAt)))
          )
        )
      )
      .returning();
    return updated;
  },

  /**
   * BAL-548 / ADR-1055 — the `transcript.failed` finder read: transcripts whose pipeline
   * FAILED, created at or before `failedBefore`, OLDEST FIRST.
   *
   * ⚠⚠ IT CARRIES `status = 'failed'` **AND** `failed_stage IS NOT NULL`, AND BOTH TERMS STAY
   * — mirroring `meetingRecordingsRepository.listFailedSince`. The index
   * (`transcript_failed_idx`) is columns-only, predicated on `failed_stage IS NOT NULL` alone
   * (this table's ADD-VALUE house rule), so a read carrying only `status = 'failed'` gives
   * Postgres no way to prove that predicate implies the index's — it CANNOT use the index and
   * seq-scans `transcripts` instead. Adding `failed_stage IS NOT NULL` here (a subset of the
   * index predicate) is what makes the index usable.
   *
   * The `status = 'failed'` term does NOT become redundant once `failed_stage IS NOT NULL` is
   * added: {@link transcriptsRepository.recordStageSkip} ALSO stamps `failed_stage`/
   * `failure_reason` — on a DEGRADED-BUT-COMPLETED path that leaves `status` untouched, so a
   * `ready` row can legitimately carry a stage. Dropping the status term would surface every
   * recorded stage SKIP in the admin queue as a failure. Today
   * {@link transcriptsRepository.markFailed} is the only writer of `status = 'failed'` and
   * always sets `failed_stage` with it, so the two terms agree on every real row; both stay so
   * they keep agreeing if that ever changes, and so the index stays usable.
   *
   * ⚠ `limit` IS A BATCH BOUND THE CALLER MUST WARN ABOUT WHEN IT FILLS. No silent caps.
   *
   * ⚠ THE MEETING JOIN IS INNER, WITH `meetings.deleted_at IS NULL` IN THE JOIN CONDITION — a
   * failed transcript of a soft-deleted meeting is not work anybody can do. There is no
   * `meetings.title` column, so the projection carries `scheduled_start` and the finder words
   * the row from it.
   */
  async listFailedSince(failedBefore: Date, limit: number): Promise<FailedTranscriptAlertRow[]> {
    return db
      .select({
        transcriptId: transcripts.id,
        meetingId: transcripts.meetingId,
        meetingScheduledStart: meetings.scheduledStart,
        failedStage: transcripts.failedStage,
        failureReason: transcripts.failureReason,
        createdAt: transcripts.createdAt,
      })
      .from(transcripts)
      .innerJoin(meetings, and(eq(meetings.id, transcripts.meetingId), isNull(meetings.deletedAt)))
      .where(
        and(
          eq(transcripts.status, 'failed'),
          isNotNull(transcripts.failedStage),
          isNull(transcripts.deletedAt),
          lte(transcripts.createdAt, failedBefore)
        )
      )
      .orderBy(asc(transcripts.createdAt), asc(transcripts.id))
      .limit(limit);
  },
};
