import { and, eq, isNull } from 'drizzle-orm';
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
 * fall to their column defaults (`processing` / `true`). `recordingRef` is deferred (no live
 * producer). `captureId` is the stable dedup key (partial-unique + BullMQ jobId basis).
 */
export interface InsertRawTranscriptInput {
  captureId: string;
  engagementId: string;
  meetingId?: string | null;
  vendor: TranscriptVendor;
  canonical: CanonicalTranscript;
  recordingRef?: string | null;
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
        meetingId: input.meetingId ?? null,
        vendor: input.vendor,
        canonical: input.canonical,
        recordingRef: input.recordingRef ?? null,
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
};
