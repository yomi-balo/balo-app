import type { CanonicalTranscript, TranscriptVendor } from '@balo/db';
import type { DailyDeepgramTranscriptPayload, RecallTranscriptPayload } from './types.js';
import { normalizeDailyDeepgram } from './daily-deepgram.js';
import { normalizeRecall } from './recall.js';

export type {
  DailyDeepgramTranscriptPayload,
  RecallTranscriptPayload,
  DailyDeepgramParticipant,
  DailyDeepgramUtterance,
  RecallDiarizedSpeaker,
  RecallUtterance,
} from './types.js';
export { normalizeDailyDeepgram } from './daily-deepgram.js';
export { normalizeRecall } from './recall.js';

/** The raw vendor payload union carried on the enqueue seam + BullMQ job data. */
export type VendorTranscriptPayload = DailyDeepgramTranscriptPayload | RecallTranscriptPayload;

/**
 * Route a raw vendor payload to its normalizer → the ONE canonical transcript. The two
 * vendors are exhaustive (`transcript_vendor` enum); the enqueue seam pairs `vendor` with its
 * matching `payload`, so the per-arm narrowing is safe. An unknown vendor is a programmer
 * error, thrown loudly.
 */
export function normalizeVendorPayload(
  vendor: TranscriptVendor,
  payload: VendorTranscriptPayload
): CanonicalTranscript {
  switch (vendor) {
    case 'daily_deepgram':
      return normalizeDailyDeepgram(payload as DailyDeepgramTranscriptPayload);
    case 'recall':
      return normalizeRecall(payload as RecallTranscriptPayload);
    default: {
      const exhaustive: never = vendor;
      throw new Error(`Unknown transcript vendor: ${String(exhaustive)}`);
    }
  }
}
