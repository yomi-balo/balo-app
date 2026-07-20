import type { CanonicalTranscript } from '@balo/db';
import type { RecallTranscriptPayload } from './types.js';
import { assembleCanonical, type RawTurn } from './assemble.js';

/** Synthetic speaker ref for an utterance with no diarization label. */
const UNKNOWN_SPEAKER_REF = 'unknown';

/**
 * Normalize a Recall bot payload (external venues) → the ONE canonical transcript. Speaker
 * attribution rides the DIARIZATION label (`source: 'diarized'`, `ref = label`, `userId`
 * always `null` — Recall never authenticates a Balo user); an absent/empty label maps to the
 * synthetic `'unknown'` ref. Segments are sorted by `startMs`; `fillerWords: true`.
 */
export function normalizeRecall(payload: RecallTranscriptPayload): CanonicalTranscript {
  const displayNameByLabel = new Map<string, string | null>();
  for (const speaker of payload.speakers) {
    displayNameByLabel.set(speaker.label, speaker.displayName);
  }

  const turns: RawTurn[] = payload.utterances.map((utterance) => {
    const label =
      typeof utterance.speaker === 'string' && utterance.speaker.length > 0
        ? utterance.speaker
        : null;
    return {
      ref: label ?? UNKNOWN_SPEAKER_REF,
      displayName: label === null ? null : (displayNameByLabel.get(label) ?? null),
      userId: null,
      source: 'diarized',
      startSec: utterance.start,
      endSec: utterance.end,
      text: utterance.text,
      confidence: utterance.confidence,
    };
  });

  return assembleCanonical({
    vendor: 'recall',
    language: payload.language,
    durationSeconds: payload.durationSeconds,
    turns,
  });
}
