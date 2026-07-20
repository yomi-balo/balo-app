/**
 * BAL-387 (ADR-1013 + ADR-1043) — transcript pipeline analytics.
 *
 * SERVER-ONLY. All three events fire from the API transcript pipeline / capture-failure seam via
 * `trackServer`. They must NOT be added to `AllEvents` (the client union) nor to the
 * `apps/web/src/test/setup.ts` client mock — that mock is client-only.
 *
 * NO PII: only the engagement id, the meeting id (nullable no-FK seam), the vendor/venue, counts,
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
} as const;

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
    meeting_id: string | null;
    vendor: 'daily_deepgram' | 'recall';
    segment_count: number;
    /** Pipeline elapsed ms — answers "how long the pipeline takes". */
    duration_ms: number | null;
    distinct_id: string;
  };
  [TRANSCRIPT_SERVER_EVENTS.SUMMARY_READY]: {
    engagement_id: string;
    meeting_id: string | null;
    action_item_count: number;
    /** Pipeline elapsed ms. */
    duration_ms: number | null;
    distinct_id: string;
  };
}
