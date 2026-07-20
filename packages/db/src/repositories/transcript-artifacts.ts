import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  transcriptArtifacts,
  type TranscriptArtifact,
  type TranscriptArtifactKind,
} from '../schema';

/**
 * Input for persisting an LLM-derived artifact (cleaned / summary) with its audit provenance.
 * `content` may be empty (the Noop LLM path — no non-empty CHECK). `modelVersion` is nullable
 * (only the resolved snapshot when surfaced); the remaining audit fields are required so
 * cleaned-vs-raw stays auditable (ADR-1013).
 */
export interface UpsertTranscriptArtifactInput {
  transcriptId: string;
  kind: TranscriptArtifactKind;
  content: string;
  provider: string;
  modelId: string;
  modelVersion?: string | null;
  promptId: string;
  promptVersion: string;
  prompt: string;
}

/**
 * `transcriptArtifactsRepository` (BAL-387) — the cleaned / summary artifacts. `upsert` is the
 * cleaned/summary stage's idempotent write: the `(transcript_id, kind)` partial-unique IS the
 * stage gate, so a retried LLM stage never re-spends. `findByTranscriptAndKind` is the pipeline
 * gate read (skip the stage when its artifact already exists).
 */
export const transcriptArtifactsRepository = {
  /**
   * Persist an artifact for `(transcript, kind)`, EXACTLY ONCE. `onConflictDoNothing` on the
   * `(transcript_id, kind)` PARTIAL unique (arbiter predicate `deleted_at IS NULL` matches
   * `transcript_artifact_kind_idx`) — a first write returns the fresh row; a retried stage
   * conflicts, DO NOTHING, and the existing row is re-read. Returns the created-or-existing row.
   */
  async upsert(input: UpsertTranscriptArtifactInput): Promise<TranscriptArtifact> {
    const [inserted] = await db
      .insert(transcriptArtifacts)
      .values({
        transcriptId: input.transcriptId,
        kind: input.kind,
        content: input.content,
        provider: input.provider,
        modelId: input.modelId,
        modelVersion: input.modelVersion ?? null,
        promptId: input.promptId,
        promptVersion: input.promptVersion,
        prompt: input.prompt,
      })
      .onConflictDoNothing({
        target: [transcriptArtifacts.transcriptId, transcriptArtifacts.kind], // arbiter = PARTIAL unique
        where: isNull(transcriptArtifacts.deletedAt), // predicate MUST match the index exactly
      })
      .returning();

    if (inserted !== undefined) {
      return inserted;
    }

    // Conflict on the partial-unique — the artifact already exists for this (transcript, kind).
    const existing = await this.findByTranscriptAndKind(input.transcriptId, input.kind);
    if (existing === undefined) {
      throw new Error(
        `transcript_artifacts.upsert conflicted but no live artifact was found for transcript ${input.transcriptId} kind ${input.kind}`
      );
    }
    return existing;
  },

  /** All live artifacts for a transcript. Rides `transcript_artifact_transcript_idx`. */
  async findByTranscript(transcriptId: string): Promise<TranscriptArtifact[]> {
    return db
      .select()
      .from(transcriptArtifacts)
      .where(
        and(
          eq(transcriptArtifacts.transcriptId, transcriptId),
          isNull(transcriptArtifacts.deletedAt)
        )
      );
  },

  /**
   * The live artifact for a `(transcript, kind)`, if any — the pipeline's stage gate read
   * (skip cleanup/summary when its artifact already exists). Rides `transcript_artifact_kind_idx`.
   */
  async findByTranscriptAndKind(
    transcriptId: string,
    kind: TranscriptArtifactKind
  ): Promise<TranscriptArtifact | undefined> {
    const [row] = await db
      .select()
      .from(transcriptArtifacts)
      .where(
        and(
          eq(transcriptArtifacts.transcriptId, transcriptId),
          eq(transcriptArtifacts.kind, kind),
          isNull(transcriptArtifacts.deletedAt)
        )
      )
      .limit(1);
    return row;
  },
};
