/**
 * BAL-387 (ADR-1013 + ADR-1043) — transcript pipeline analytics.
 *
 * SERVER-ONLY. These events fire from the API transcript pipeline / capture-failure seam via
 * `trackServer`. They must NOT be added to `AllEvents` (the client union) nor to the
 * `apps/web/src/test/setup.ts` client mock — that mock is client-only.
 *
 * NO PII: only the engagement id, the meeting id (BAL-418: a real `meetings.id`), the vendor/venue, counts,
 * elapsed pipeline ms, a free-text failure reason, and a stable system `distinct_id`
 * (`'system:transcript-pipeline'`, since the producer-less pipeline has no human actor) — never a
 * party name/email or transcript content.
 */
export const TRANSCRIPT_SERVER_EVENTS = {
  /** A capture / bot join failed (the inert capture-failure seam). */
  BOT_JOIN_FAILED: 'bot_join_failed',
  /** The raw canonical transcript was persisted (newly, once per capture). */
  TRANSCRIPT_READY: 'transcript_ready',
  /** The summary + action items were produced (newly, once per capture). */
  SUMMARY_READY: 'summary_ready',
  /** The pipeline permanently failed after exhausting retries (from worker.on('failed')). */
  TRANSCRIPT_FAILED: 'transcript_failed',
  /** The summary one-liner was dropped by the money guard (observability for tuning false positives). */
  SUMMARY_HEADLINE_SUPPRESSED: 'summary_headline_suppressed',
  /** BAL-483 — a Daily Batch Processor transcript job was submitted for one recording segment. */
  TRANSCRIPT_CAPTURE_SUBMITTED: 'transcript_capture_submitted',
  /** BAL-483 — a recorded segment was deliberately NOT transcribed. The D4 gate's own metric. */
  TRANSCRIPT_CAPTURE_SKIPPED: 'transcript_capture_skipped',
  /** BAL-483 — the capture path failed terminally BEFORE the pipeline was ever enqueued. */
  TRANSCRIPT_CAPTURE_FAILED: 'transcript_capture_failed',
} as const;

/**
 * BAL-483 — why a recorded segment was not transcribed. A CLOSED SET.
 * ⚠ `no_engagement_context` is the EXPECTED, ROUTINE one: `transcripts.engagement_id` is NOT
 * NULL, and three of the seven `meeting_context_type` labels name no engagement at all. A
 * rising share of the other four is a bug signal.
 *
 * ⚠ FIX ROUND 1 (M1) — `empty_transcript` is the D9/R3 metric: Deepgram returned ZERO
 * utterances (an R3-fragmented segment where nobody spoke before hanging up). It is reused on
 * `TRANSCRIPT_CAPTURE_SKIPPED` rather than growing a new event, at the INGEST stage rather than
 * the D4 submit gate — see `jobs/transcript-capture.ts`'s `handleIngest`.
 */
export type TranscriptCaptureSkipReason =
  | 'no_engagement_context'
  | 'ambiguous_context'
  | 'engagement_missing'
  | 'meeting_missing'
  | 'no_daily_source'
  | 'empty_transcript';

/** BAL-483 — where in the capture path it broke. */
export type TranscriptCaptureFailureStage = 'batch_submit' | 'batch_job' | 'artefact_fetch';

/** BAL-483 — a CLOSED SET; never Daily's raw message. The full text lives in
 *  `meeting_recordings.transcript_job_failure_reason` and in `log.error`, both server-side. */
export type TranscriptCaptureFailureReason =
  | 'vendor_reported'
  | 'daily_api_error'
  | 'artefact_unreadable'
  | 'artefact_too_large'
  | 'config_error'
  | 'unknown';

/** Capture venue (`daily_deepgram` → `balo_video`; `recall` → `external`). */
export type TranscriptVenue = 'balo_video' | 'external';

export interface TranscriptServerEventMap {
  [TRANSCRIPT_SERVER_EVENTS.BOT_JOIN_FAILED]: {
    venue: TranscriptVenue;
    reason: string;
    distinct_id: string;
  };
  [TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_READY]: {
    engagement_id: string;
    meeting_id: string;
    vendor: 'daily_deepgram' | 'recall';
    segment_count: number;
    /** Pipeline elapsed ms — answers "how long the pipeline takes". */
    duration_ms: number | null;
    distinct_id: string;
  };
  [TRANSCRIPT_SERVER_EVENTS.SUMMARY_READY]: {
    engagement_id: string;
    meeting_id: string;
    action_item_count: number;
    /** Pipeline elapsed ms. */
    duration_ms: number | null;
    distinct_id: string;
  };
  [TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_FAILED]: {
    stage: string;
    vendor: 'daily_deepgram' | 'recall';
    distinct_id: string;
  };
  [TRANSCRIPT_SERVER_EVENTS.SUMMARY_HEADLINE_SUPPRESSED]: {
    engagement_id: string;
    meeting_id: string;
    distinct_id: string;
  };
  [TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_CAPTURE_SUBMITTED]: {
    meeting_id: string;
    /** ⚠ `meeting_recordings.id`. NEVER a vendor id. */
    recording_id: string;
    /**
     * Daily's `recording.ready-to-download.duration` — THE BILLABLE QUANTITY. The Batch
     * Processor bills per RECORDED minute, and the batch webhooks expose no
     * `participant_minutes` (the real-time transcript family did; this one does not).
     */
    duration_seconds: number | null;
    distinct_id: string;
  };
  [TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_CAPTURE_SKIPPED]: {
    meeting_id: string;
    recording_id: string;
    reason: TranscriptCaptureSkipReason;
    distinct_id: string;
  };
  [TRANSCRIPT_SERVER_EVENTS.TRANSCRIPT_CAPTURE_FAILED]: {
    meeting_id: string;
    recording_id: string;
    stage: TranscriptCaptureFailureStage;
    reason: TranscriptCaptureFailureReason;
    distinct_id: string;
  };
}
