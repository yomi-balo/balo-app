import { createLogger } from '@balo/shared/logging';
import { trackServer, TRANSCRIPT_SERVER_EVENTS } from '@balo/analytics/server';
import type { TranscriptVendor } from '@balo/db';

const log = createLogger('transcript-capture-failure');

/** Vendor → observability venue (`daily_deepgram` = Balo Video; `recall` = external). */
const VENUE_BY_VENDOR: Record<TranscriptVendor, 'balo_video' | 'external'> = {
  daily_deepgram: 'balo_video',
  recall: 'external',
};

/**
 * BAL-387 — the ingestion-failure seam. The (future) capture layer (BAL-126/BAL-140) calls this
 * when a bot fails to join / capture fails, emitting `bot_join_failed`. INERT today (no live
 * producer): it is a callable seam only, carrying NO PII (venue + reason string).
 */
export function recordCaptureFailure(input: { vendor: TranscriptVendor; reason: string }): void {
  const venue = VENUE_BY_VENDOR[input.vendor];
  log.warn({ venue, reason: input.reason }, 'Transcript capture / bot join failed');
  trackServer(TRANSCRIPT_SERVER_EVENTS.BOT_JOIN_FAILED, {
    venue,
    reason: input.reason,
    distinct_id: 'system:transcript-pipeline',
  });
}
