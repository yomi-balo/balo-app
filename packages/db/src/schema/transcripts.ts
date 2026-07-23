import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { engagements } from './engagements';
import { transcriptVendorEnum, transcriptStatusEnum, transcriptArtifactKindEnum } from './enums';
import { timestamps, softDelete } from './helpers';

// ── Canonical Transcript Schema + Normalizer Contracts (BAL-387 / ADR-1013) ──
//
// ONE canonical transcript shape both vendor normalizers (Daily/Deepgram authenticated-
// `userId` attribution; Recall name-diarization) target. Co-located here so `@balo/db`
// OWNS the jsonb `$type` and `apps/api` imports these TYPE-ONLY (no runtime bundle of
// `@balo/db` — memory `reference_balo_db_client_bundle_footgun`). The single source of
// truth for the pipeline's `canonical` / `extracted_action_items` columns.

export interface CanonicalSpeaker {
  ref: string; // stable within transcript: userId (Balo Video) or diarized label (Recall)
  displayName: string | null;
  userId: string | null; // authenticated Balo user (Daily) | null (Recall)
  source: 'authenticated' | 'diarized';
}

export interface CanonicalSegment {
  index: number;
  speakerRef: string; // → CanonicalSpeaker.ref
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
}

export interface CanonicalTranscript {
  schemaVersion: 1;
  vendor: 'daily_deepgram' | 'recall';
  language: string | null;
  fillerWords: boolean; // true for raw
  speakers: CanonicalSpeaker[];
  segments: CanonicalSegment[]; // ordered by startMs
  durationMs: number | null;
}

/**
 * One extracted action item, captured at the summary stage and stored on
 * `transcripts.extracted_action_items` before promotion via BAL-391's
 * `createFromExtraction`. `assigneeParty` is a SIDE only — the enum never allows a
 * specific person (diarized/authenticated speaker → person attribution is not
 * representable).
 */
export interface ExtractedActionItem {
  body: string;
  assigneeParty: 'client' | 'expert' | null;
  // ISO-8601 string (NOT Date): this interface is the jsonb `$type` on
  // `transcripts.extracted_action_items`, and jsonb round-trips a Date to a string. Storing it
  // as a string keeps the read/write type honest; the pipeline parses it to a Date only at the
  // `createFromExtraction` promotion boundary.
  dueAt: string | null;
}

/**
 * transcripts (BAL-387 / ADR-1013 amendment + ADR-1043) — the pipeline envelope AND
 * artifact #1 (the raw canonical transcript). One row per capture. Anchored on the
 * engagement (the only hard context — meetings deferred); the LLM-derived artifacts #2
 * (cleaned) / #3 (summary) live in `transcript_artifacts`.
 *
 * `meeting_id` is a NULLABLE, NO-FK forward seam for the meetings primitive (unbuilt) —
 * mirror `action_items.meeting_id` exactly; do NOT conflate with meeting_guests.meeting_id.
 * The FK is added in a follow-up once the table exists.
 *
 * Stage-gate columns (`action_items_extracted_at`, `recap_ready_published_at`) are durable
 * completion markers: a retried pipeline job short-circuits each stage on its marker so an
 * LLM stage never re-spends and action items are not re-created. `canonical` retains
 * `filler_words=true` (raw = faithful machine ASR); the cleaned artifact strips them.
 *
 * NO RLS (matching the credit/action-item precedents): access is gated at the application
 * layer + fee-safe projections. The recap carries no money, so lens concealment is trivial.
 *
 * ADR-1030 system-actor exemption (owner-ruled; amendment drafted/reviewed outside this PR):
 * the pipeline is exempt from durable human ATTRIBUTION because all three hold — (1) it changes
 * no party's authority/capability; (2) no money moves or accrues; (3) it writes no party-visible
 * domain rows directly — the one party-visible output (first-class `action_items`) is created via
 * BAL-391's `createFromExtraction` seam, which carries its own attribution + audit, and that
 * obligation is the seam's, not the pipeline's. The exemption is from attribution, NOT
 * observability: the status machine + stage-gate timestamps are the operational record, and the
 * two terminal-skip paths (engagement-not-active, engagement-not-found) additionally persist
 * `failed_stage`/`failure_reason` and emit the `transcript_failed` analytic.
 */
export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // The only hard anchor. CASCADE — a transcript dies with its engagement.
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),

    // Forward seam (meetings primitive, unbuilt). NULLABLE, NO FK — the table does not exist yet.
    meetingId: uuid('meeting_id'),

    // Stable vendor/capture id — the dedup key (partial-unique below) + BullMQ jobId basis.
    captureId: text('capture_id').notNull(),
    vendor: transcriptVendorEnum('vendor').notNull(),
    status: transcriptStatusEnum('status').notNull().default('processing'),

    language: text('language'),
    durationMs: integer('duration_ms'),
    // Raw retains fillers (Deepgram strips them by default; we opt in). The cleaned artifact removes them.
    fillerWords: boolean('filler_words').notNull().default(true),

    // Artifact #1: the canonical raw segments (jsonb owned here via `$type`).
    canonical: jsonb('canonical').notNull().$type<CanonicalTranscript>(),
    // No live capture producer exists (BAL-126/140) — deferred everywhere.
    recordingRef: text('recording_ref'),

    // Captured at the summary stage; survives even if not promoted to first-class action items.
    extractedActionItems: jsonb('extracted_action_items').$type<ExtractedActionItem[]>(),

    // ── Durable stage gates (idempotent resume across retries) ──
    actionItemsExtractedAt: timestamp('action_items_extracted_at', { withTimezone: true }),
    recapReadyPublishedAt: timestamp('recap_ready_published_at', { withTimezone: true }),

    // Set on exhausted retries (worker.on('failed')).
    failedStage: text('failed_stage'),
    failureReason: text('failure_reason'),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // Soft-delete-safe one-row-per-capture (memory `reference_softdelete_nonpartial_unique_recreate`):
    // PARTIAL unique on `deleted_at IS NULL` so a soft-deleted + re-captured transcript can re-insert.
    // The `insertRaw` `onConflictDoNothing` arbiter matches this predicate exactly.
    uniqueIndex('transcript_capture_id_idx')
      .on(t.captureId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('transcript_engagement_idx').on(t.engagementId),
    // Forward seam read (BAL-388 recap by meeting). Partial on non-null meeting + live — mirrors
    // `action_item_meeting_idx`. Predicate references ONLY meeting_id/deleted_at (the ADD-VALUE house rule).
    index('transcript_meeting_idx')
      .on(t.meetingId)
      .where(sql`${t.meetingId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ]
);

/**
 * transcript_artifacts (BAL-387 / ADR-1013) — artifacts #2 (cleaned) and #3 (summary),
 * each with its OWN LLM audit provenance (ADR-1013: "store cleanup model id + version +
 * prompt" so cleaned-vs-raw is auditable). One row per `(transcript, kind)`; that partial
 * uniqueness IS the cleaned/summary stage gate (a retried stage never re-spends).
 *
 * `content` has NO non-empty CHECK — the Noop LLM path (absent ANTHROPIC_API_KEY) may
 * write an empty summary, and the pipeline must still complete end-to-end.
 */
export const transcriptArtifacts = pgTable(
  'transcript_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // CASCADE — an artifact dies with its transcript.
    transcriptId: uuid('transcript_id')
      .notNull()
      .references(() => transcripts.id, { onDelete: 'cascade' }),

    kind: transcriptArtifactKindEnum('kind').notNull(),
    content: text('content').notNull(), // cleaned full text / summary text (may be empty on the Noop path)

    // ── LLM audit provenance (persisted per artifact) ──
    provider: text('provider').notNull(), // e.g. 'anthropic'
    modelId: text('model_id').notNull(), // e.g. 'claude-sonnet-5'
    modelVersion: text('model_version'), // resolved model/snapshot if surfaced
    promptId: text('prompt_id').notNull(), // e.g. 'transcript.cleanup'
    promptVersion: text('prompt_version').notNull(), // e.g. 'v1'
    prompt: text('prompt').notNull(), // exact rendered prompt (audit)

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // The cleaned/summary stage gate: one live artifact per (transcript, kind). PARTIAL on
    // `deleted_at IS NULL` (soft-delete re-record safety). The `upsert` onConflictDoNothing
    // arbiter matches this predicate exactly.
    uniqueIndex('transcript_artifact_kind_idx')
      .on(t.transcriptId, t.kind)
      .where(sql`${t.deletedAt} IS NULL`),
    index('transcript_artifact_transcript_idx').on(t.transcriptId),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const transcriptsRelations = relations(transcripts, ({ one, many }) => ({
  engagement: one(engagements, {
    fields: [transcripts.engagementId],
    references: [engagements.id],
  }),
  artifacts: many(transcriptArtifacts),
}));

export const transcriptArtifactsRelations = relations(transcriptArtifacts, ({ one }) => ({
  transcript: one(transcripts, {
    fields: [transcriptArtifacts.transcriptId],
    references: [transcripts.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type Transcript = typeof transcripts.$inferSelect;
export type NewTranscript = typeof transcripts.$inferInsert;
export type TranscriptArtifact = typeof transcriptArtifacts.$inferSelect;
export type NewTranscriptArtifact = typeof transcriptArtifacts.$inferInsert;

/** Capture vendor (schema-derived — single source of truth). */
export type TranscriptVendor = (typeof transcriptVendorEnum.enumValues)[number];
/** Coarse transcript lifecycle status (schema-derived). */
export type TranscriptStatus = (typeof transcriptStatusEnum.enumValues)[number];
/** LLM-derived artifact kind (schema-derived). */
export type TranscriptArtifactKind = (typeof transcriptArtifactKindEnum.enumValues)[number];
