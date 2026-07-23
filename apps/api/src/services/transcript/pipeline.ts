import {
  transcriptsRepository,
  transcriptArtifactsRepository,
  actionItemsRepository,
  engagementsRepository,
  companiesRepository,
  EngagementNotActiveError,
  type Transcript,
  type TranscriptVendor,
  type ExtractedActionItem,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type { RecapReadyPayload } from '@balo/shared/notifications';
import { trackServer, TRANSCRIPT_SERVER_EVENTS } from '@balo/analytics/server';
import { notificationEvents } from '../../notifications/index.js';
import { normalizeVendorPayload, type VendorTranscriptPayload } from './normalizers/index.js';
import type { LlmAudit, LlmClient } from './llm/types.js';

const log = createLogger('transcript-pipeline');

/** The stable analytics subject for the producer-less pipeline (no human actor). */
const PIPELINE_DISTINCT_ID = 'system:transcript-pipeline';

/** Cap the summary one-liner carried on the recap payload (no fee content). */
const SUMMARY_HEADLINE_MAX = 140;

/** Parse a stored ISO `dueAt` to a Date at the createFromExtraction boundary; null on absent/invalid. */
function toDueAtDate(iso: string | null): Date | null {
  if (iso === null) {
    return null;
  }
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The sequential stages, in order — surfaced on `TranscriptStageError.stage` + `markFailed`. */
export type TranscriptStage =
  | 'normalize'
  | 'persist_raw'
  | 'cleanup'
  | 'summarize'
  | 'extract_action_items'
  | 'publish_recap';

/** Wraps a stage failure so the worker's `on('failed')` can record WHICH stage failed. */
export class TranscriptStageError extends Error {
  readonly stage: TranscriptStage;

  constructor(stage: TranscriptStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TranscriptStageError';
    this.stage = stage;
    this.cause = cause;
  }
}

/** The fixture-driven job data (mirrors the enqueue seam). */
export interface TranscriptPipelineJobInput {
  captureId: string;
  engagementId: string;
  meetingId?: string | null;
  vendor: TranscriptVendor;
  payload: VendorTranscriptPayload;
  recordingRef?: string | null;
  durationMs?: number | null;
}

/** Injected deps — the LLM seam is swapped for a deterministic fake in tests. */
export interface TranscriptPipelineDeps {
  llm: LlmClient;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map the LLM audit onto the `transcript_artifacts` audit columns. */
function auditColumns(audit: LlmAudit): {
  provider: string;
  modelId: string;
  modelVersion: string | null;
  promptId: string;
  promptVersion: string;
  prompt: string;
} {
  return {
    provider: audit.provider,
    modelId: audit.modelId,
    modelVersion: audit.modelVersion,
    promptId: audit.promptId,
    promptVersion: audit.promptVersion,
    prompt: audit.prompt,
  };
}

/**
 * UNAMBIGUOUS money signals that must never surface on the lens-shared recap headline
 * (defense-in-depth). Deliberately NARROW — currency symbols/codes, explicit per-hour rate
 * expressions, and `fee(s)`/`invoice`. Ordinary consulting words (`rate`, `rates`, `quote`,
 * `price`, `pricing`, `cost`) are EXCLUDED: they collide with non-commercial usage ("rate of
 * adoption", "a quote from their vendor doc"). Suppression is now observable (an analytic fires),
 * so any residual false positives can be measured and the vocabulary tuned. Flat quantifier-free
 * alternation (ReDoS-safe re SonarCloud S5852).
 */
const MONEY_RATE_PATTERN =
  /(\$|€|£|₤|\bAUD\b|\bUSD\b|\bGBP\b|\bEUR\b|\bper hour\b|\bper hr\b|\/hr\b|\/hour\b|\bhourly\b|\bfees?\b|\binvoice\b)/i;

/**
 * Short, plain-text, party-safe headline from the summary. `suppressed` is `true` ONLY when the
 * money guard matched (so the caller can emit a tuning analytic) — an empty/Noop summary yields
 * `{ headline: undefined, suppressed: false }` (nothing to suppress).
 */
function buildSummaryHeadline(summary: string): {
  headline: string | undefined;
  suppressed: boolean;
} {
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    return { headline: undefined, suppressed: false };
  }
  const [firstLine] = trimmed.split('\n');
  const oneLiner =
    firstLine !== undefined && firstLine.trim().length > 0 ? firstLine.trim() : trimmed;
  // Defense-in-depth: never surface a money one-liner on the lens-shared recap. A dropped headline
  // just means the recap has no one-liner — it still fires — and the caller records the suppression.
  if (MONEY_RATE_PATTERN.test(oneLiner)) {
    return { headline: undefined, suppressed: true };
  }
  const headline =
    oneLiner.length > SUMMARY_HEADLINE_MAX
      ? `${oneLiner.slice(0, SUMMARY_HEADLINE_MAX)}…`
      : oneLiner;
  return { headline, suppressed: false };
}

/**
 * Stage 2 — persist the raw canonical transcript EXACTLY ONCE (`onConflictDoNothing` on the
 * partial-unique `capture_id`). `transcript_ready` analytics fires only when newly created
 * (a retried job re-reads the existing row and does not re-emit).
 */
async function stagePersistRaw(
  job: TranscriptPipelineJobInput,
  canonical: ReturnType<typeof normalizeVendorPayload>,
  startedAt: number
): Promise<Transcript> {
  const existingBefore = await transcriptsRepository.findByCaptureId(job.captureId);
  const transcript = await transcriptsRepository.insertRaw({
    captureId: job.captureId,
    engagementId: job.engagementId,
    meetingId: job.meetingId,
    vendor: job.vendor,
    canonical,
    recordingRef: job.recordingRef,
    language: canonical.language,
    durationMs: job.durationMs ?? canonical.durationMs,
  });

  if (existingBefore === undefined) {
    log.info(
      { transcriptId: transcript.id, captureId: job.captureId },
      'Transcript persisted (raw)'
    );
    trackServer(TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_READY, {
      engagement_id: transcript.engagementId,
      meeting_id: transcript.meetingId,
      vendor: transcript.vendor,
      segment_count: canonical.segments.length,
      duration_ms: Date.now() - startedAt,
      distinct_id: PIPELINE_DISTINCT_ID,
    });
  }
  return transcript;
}

/**
 * Stage 3 — cleanup. Gated on the cleaned artifact's existence (its `(transcript, kind)`
 * partial-unique IS the gate); a retried stage never re-spends the LLM. Returns the cleaned
 * text for the summary stage.
 */
async function stageCleanup(
  transcript: Transcript,
  canonical: ReturnType<typeof normalizeVendorPayload>,
  llm: LlmClient
): Promise<string> {
  const existing = await transcriptArtifactsRepository.findByTranscriptAndKind(
    transcript.id,
    'cleaned'
  );
  if (existing !== undefined) {
    return existing.content;
  }
  const cleaned = await llm.cleanupTranscript({ transcript: canonical });
  const artifact = await transcriptArtifactsRepository.upsert({
    transcriptId: transcript.id,
    kind: 'cleaned',
    content: cleaned.text,
    ...auditColumns(cleaned.audit),
  });
  log.info({ transcriptId: transcript.id }, 'Transcript cleaned');
  return artifact.content;
}

/**
 * Stage 4 — summary + extraction. Gated on the summary artifact; when it already exists, the
 * extracted items are re-read from the transcript row. `summary_ready` analytics fires only when
 * newly created. Ordering matters: the extracted items are persisted to the row BEFORE the
 * summary artifact is upserted, so the artifact (the skip gate) reliably implies the items are on
 * the row — a crash between the two writes just re-runs the stage on retry, never losing items.
 */
async function stageSummaryExtract(
  transcript: Transcript,
  cleanedText: string,
  llm: LlmClient,
  startedAt: number
): Promise<{ summaryText: string; extractedItems: ExtractedActionItem[] }> {
  const existing = await transcriptArtifactsRepository.findByTranscriptAndKind(
    transcript.id,
    'summary'
  );
  if (existing !== undefined) {
    return { summaryText: existing.content, extractedItems: transcript.extractedActionItems ?? [] };
  }

  const summarized = await llm.summarize({ cleanedText });
  const extracted = await llm.extractActionItems({ cleanedText, summary: summarized.summary });
  await transcriptsRepository.setExtractedActionItems(transcript.id, extracted.items);
  const summaryArtifact = await transcriptArtifactsRepository.upsert({
    transcriptId: transcript.id,
    kind: 'summary',
    content: summarized.summary,
    ...auditColumns(summarized.audit),
  });

  log.info(
    { transcriptId: transcript.id, actionItemCount: extracted.items.length },
    'Transcript summarized + action items extracted'
  );
  trackServer(TRANSCRIPT_SERVER_EVENTS.SUMMARY_READY, {
    engagement_id: transcript.engagementId,
    meeting_id: transcript.meetingId,
    action_item_count: extracted.items.length,
    duration_ms: Date.now() - startedAt,
    distinct_id: PIPELINE_DISTINCT_ID,
  });

  return { summaryText: summaryArtifact.content, extractedItems: extracted.items };
}

/**
 * Stage 5 (the critical at-least-once gate) — promote the extracted items to first-class action
 * items via BAL-391's self-transactional `createFromExtraction`, THEN stamp
 * `action_items_extracted_at`. A non-active engagement (`EngagementNotActiveError`) is a terminal
 * skip: warn, stamp anyway (so the job doesn't retry forever), items retained on the row.
 */
async function stagePromoteActionItems(
  transcript: Transcript,
  extractedItems: ExtractedActionItem[]
): Promise<void> {
  if (transcript.actionItemsExtractedAt !== null) {
    return;
  }
  try {
    await actionItemsRepository.createFromExtraction({
      engagementId: transcript.engagementId,
      meetingId: transcript.meetingId,
      actorUserId: null,
      items: extractedItems.map((item) => ({
        body: item.body,
        assigneeParty: item.assigneeParty,
        dueAt: toDueAtDate(item.dueAt),
      })),
    });
    await transcriptsRepository.markActionItemsExtracted(transcript.id);
    log.info(
      { transcriptId: transcript.id, actionItemCount: extractedItems.length },
      'Action items promoted'
    );
  } catch (error) {
    if (error instanceof EngagementNotActiveError) {
      log.warn(
        { transcriptId: transcript.id, engagementId: transcript.engagementId },
        'Engagement not active — skipping action-item promotion (items retained; terminal skip)'
      );
      // ADR-1030: the exemption is from attribution, not observability. Persist the degradation
      // (status UNCHANGED — the recap still publishes downstream) and emit the failure analytic.
      await transcriptsRepository.recordStageSkip(
        transcript.id,
        'extract_action_items',
        'engagement_not_active'
      );
      trackServer(TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_FAILED, {
        stage: 'extract_action_items',
        vendor: transcript.vendor,
        distinct_id: PIPELINE_DISTINCT_ID,
      });
      await transcriptsRepository.markActionItemsExtracted(transcript.id);
      return;
    }
    throw error;
  }
}

/**
 * Stage 6 — assemble the recap payload and fire `recap.ready` to both parties, THEN stamp
 * `recap_ready_published_at` + flip status to `ready`. Two idempotency layers (this gate + the
 * notification engine's `jobId` dedup) collapse a double publish. Carries NO money (lens-safe).
 */
async function stagePublishRecap(
  transcript: Transcript,
  summaryText: string,
  extractedItems: ExtractedActionItem[]
): Promise<void> {
  if (transcript.recapReadyPublishedAt !== null) {
    return;
  }

  const engagement = await engagementsRepository.findById(transcript.engagementId);
  if (engagement === undefined) {
    log.warn(
      { transcriptId: transcript.id, engagementId: transcript.engagementId },
      'Engagement not found — recap cannot be delivered, marking failed (terminal skip)'
    );
    // Genuine terminal failure: nothing was published, so `status='failed'` is honest (NOT
    // markRecapPublished). ADR-1030 observability: record + emit the failure analytic.
    await transcriptsRepository.markFailed(transcript.id, 'publish_recap', 'engagement_not_found');
    trackServer(TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_FAILED, {
      stage: 'publish_recap',
      vendor: transcript.vendor,
      distinct_id: PIPELINE_DISTINCT_ID,
    });
    return;
  }

  const recipientId = await companiesRepository.findOwnerUserIdByCompanyId(engagement.companyId);
  const { headline, suppressed } = buildSummaryHeadline(summaryText);
  const payload: RecapReadyPayload = {
    correlationId: `${transcript.id}:recap_ready`,
    engagementId: transcript.engagementId,
    transcriptId: transcript.id,
    meetingId: transcript.meetingId,
    recipientId,
    expertProfileId: engagement.expertProfileId,
    actionItemCount: extractedItems.length,
    summaryHeadline: headline,
    recordingRef: transcript.recordingRef,
  };
  if (suppressed) {
    // Observability for the money guard: lets us measure false positives + tune the vocabulary.
    trackServer(TRANSCRIPT_SERVER_EVENTS.SUMMARY_HEADLINE_SUPPRESSED, {
      engagement_id: transcript.engagementId,
      meeting_id: transcript.meetingId,
      distinct_id: PIPELINE_DISTINCT_ID,
    });
  }
  await notificationEvents.publish('recap.ready', payload);
  await transcriptsRepository.markRecapPublished(transcript.id);
  log.info({ transcriptId: transcript.id }, 'Recap published (recap.ready)');
}

/**
 * BAL-387 (ADR-1013 + ADR-1043) — the transcript pipeline. Runs the six sequential, individually
 * gated stages (each `gate → work → mark`) over a fixture payload; pure of BullMQ (takes the
 * job data + injected `{ llm }`). A retry re-enters and each stage short-circuits on its durable
 * marker, so an LLM stage never re-spends and action items are not re-created. A stage that does
 * real work `log.info`s; a caught-and-rethrown failure `log.error`s (BullMQ retries).
 */
export async function runTranscriptPipeline(
  job: TranscriptPipelineJobInput,
  deps: TranscriptPipelineDeps
): Promise<void> {
  const startedAt = Date.now();
  let stage: TranscriptStage = 'normalize';
  try {
    const canonical = normalizeVendorPayload(job.vendor, job.payload);

    stage = 'persist_raw';
    const transcript = await stagePersistRaw(job, canonical, startedAt);

    stage = 'cleanup';
    const cleanedText = await stageCleanup(transcript, canonical, deps.llm);

    stage = 'summarize';
    const { summaryText, extractedItems } = await stageSummaryExtract(
      transcript,
      cleanedText,
      deps.llm,
      startedAt
    );

    stage = 'extract_action_items';
    await stagePromoteActionItems(transcript, extractedItems);

    stage = 'publish_recap';
    await stagePublishRecap(transcript, summaryText, extractedItems);
  } catch (error) {
    log.error(
      {
        stage,
        captureId: job.captureId,
        error: errorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Transcript pipeline stage failed'
    );
    throw new TranscriptStageError(stage, error);
  }
}
