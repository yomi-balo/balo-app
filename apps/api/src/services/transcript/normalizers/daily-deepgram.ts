import type { CanonicalTranscript } from '@balo/db';
import type { DailyDeepgramTranscriptPayload } from './types.js';
import { assembleCanonical, type RawTurn } from './assemble.js';

/** Synthetic speaker ref for an utterance with no authenticated attribution. */
const UNKNOWN_SPEAKER_REF = 'unknown';

/**
 * Normalize a Daily-native Deepgram payload (Balo Video) → the ONE canonical transcript.
 * Speaker attribution rides the AUTHENTICATED Daily `userId` (`source: 'authenticated'`,
 * `ref = userId`); an absent/empty user maps to the synthetic `'unknown'` ref (never drops
 * a segment). Segments are sorted by `startMs`; `fillerWords: true` (raw retains fillers).
 */
export function normalizeDailyDeepgram(
  payload: DailyDeepgramTranscriptPayload
): CanonicalTranscript {
  const displayNameByUserId = new Map<string, string | null>();
  for (const participant of payload.participants) {
    displayNameByUserId.set(participant.userId, participant.displayName);
  }

  const turns: RawTurn[] = payload.utterances.map((utterance) => {
    const userId =
      typeof utterance.userId === 'string' && utterance.userId.length > 0 ? utterance.userId : null;
    return {
      ref: userId ?? UNKNOWN_SPEAKER_REF,
      displayName: userId === null ? null : (displayNameByUserId.get(userId) ?? null),
      userId,
      source: 'authenticated',
      startSec: utterance.start,
      endSec: utterance.end,
      text: utterance.transcript,
      confidence: utterance.confidence,
    };
  });

  return assembleCanonical({
    vendor: 'daily_deepgram',
    language: payload.language,
    durationSeconds: payload.durationSeconds,
    turns,
  });
}
