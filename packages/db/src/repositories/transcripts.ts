import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  transcripts,
  type Transcript,
  type TranscriptVendor,
  type CanonicalTranscript,
  type ExtractedActionItem,
} from '../schema';

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

  /** ONE live transcript by id. `undefined` when missing or soft-deleted. */
  async findById(id: string): Promise<Transcript | undefined> {
    const [row] = await db
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
};
