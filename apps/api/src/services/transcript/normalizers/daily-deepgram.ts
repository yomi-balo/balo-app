import type { CanonicalTranscript } from '@balo/db';
import type { DailyDeepgramTranscriptPayload, DailyDeepgramUtterance } from './types.js';
import { assembleCanonical, type RawTurn } from './assemble.js';

/** Synthetic speaker ref for an utterance with no attribution at all (either model). */
const UNKNOWN_SPEAKER_REF = 'unknown';

/**
 * The `attribution: 'authenticated'` (default) turn builder — the real-time capture path.
 * Speaker attribution rides the AUTHENTICATED Daily `userId` (`source: 'authenticated'`,
 * `ref = userId`); an absent/empty user maps to the synthetic `'unknown'` ref (never drops
 * a segment). Unchanged from the pre-BAL-483 body.
 */
function authenticatedTurn(
  utterance: DailyDeepgramUtterance,
  displayNameByUserId: Map<string, string | null>
): RawTurn {
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
}

/**
 * BAL-483 — the `attribution: 'diarized'` turn builder — the post-call Daily Batch Processor
 * path. Speaker attribution rides the DIARIZATION label (`source: 'diarized'`, `userId: null`
 * always — an ordinal is NOT a Balo user, see the plan's ⚠ RISK R1); an absent/empty label maps
 * to the synthetic `'unknown'` ref.
 */
function diarizedTurn(utterance: DailyDeepgramUtterance): RawTurn {
  const label =
    typeof utterance.speakerLabel === 'string' && utterance.speakerLabel.length > 0
      ? utterance.speakerLabel
      : null;
  return {
    ref: label ?? UNKNOWN_SPEAKER_REF,
    displayName: null, // ⚠ we know no names on this path — never invent one
    userId: null, // ⚠⚠ an ordinal is NOT a Balo user. See BAL-483 ⚠ RISK R1.
    source: 'diarized',
    startSec: utterance.start,
    endSec: utterance.end,
    text: utterance.transcript,
    confidence: utterance.confidence,
  };
}

/**
 * Normalize a Daily-native Deepgram payload → the ONE canonical transcript. Two attribution
 * models, picked by `payload.attribution` (BAL-483):
 *   · `'authenticated'` (default, absent) — the real-time capture path, `ref = userId`.
 *   · `'diarized'` — the post-call Batch Processor path, `ref = speakerLabel`, `userId: null`.
 * Segments are sorted by `startMs`; `fillerWords: true` (raw retains fillers), on both.
 */
export function normalizeDailyDeepgram(
  payload: DailyDeepgramTranscriptPayload
): CanonicalTranscript {
  const displayNameByUserId = new Map<string, string | null>();
  for (const participant of payload.participants) {
    displayNameByUserId.set(participant.userId, participant.displayName);
  }

  const turns: RawTurn[] =
    payload.attribution === 'diarized'
      ? payload.utterances.map((utterance) => diarizedTurn(utterance))
      : payload.utterances.map((utterance) => authenticatedTurn(utterance, displayNameByUserId));

  return assembleCanonical({
    vendor: 'daily_deepgram',
    language: payload.language,
    durationSeconds: payload.durationSeconds,
    turns,
  });
}
