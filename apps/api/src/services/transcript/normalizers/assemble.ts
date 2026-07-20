import type {
  CanonicalTranscript,
  CanonicalSpeaker,
  CanonicalSegment,
  TranscriptVendor,
} from '@balo/db';

/**
 * A vendor-agnostic speaker turn — the normalizers' shared intermediate. Each vendor
 * normalizer maps its raw utterances into `RawTurn`s (carrying the vendor-specific speaker
 * attribution) and hands them here; the ordering / indexing / ms-coercion / speaker-collection
 * rules then live in exactly ONE place (SonarCloud new-code duplication + drift safety).
 */
export interface RawTurn {
  ref: string; // stable speaker ref within the transcript
  displayName: string | null;
  userId: string | null; // authenticated Balo user (Daily) | null (Recall)
  source: CanonicalSpeaker['source'];
  startSec: number;
  endSec: number;
  text: string;
  confidence: number | null;
}

/** Coerce a second-precision vendor timestamp to whole ms (the canonical unit). */
function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/**
 * Fold vendor turns into ONE canonical transcript: sort by start time, index sequentially,
 * coerce second-timestamps to ms, and collect the distinct speakers in first-appearance
 * order. `fillerWords` is always `true` (the raw artifact is faithful machine ASR; the
 * cleaned artifact strips fillers).
 */
export function assembleCanonical(input: {
  vendor: TranscriptVendor;
  language: string | null;
  durationSeconds: number | null;
  turns: RawTurn[];
}): CanonicalTranscript {
  const ordered = [...input.turns].sort((a, b) => a.startSec - b.startSec);

  const segments: CanonicalSegment[] = ordered.map((turn, index) => ({
    index,
    speakerRef: turn.ref,
    startMs: secondsToMs(turn.startSec),
    endMs: secondsToMs(turn.endSec),
    text: turn.text,
    confidence: turn.confidence,
  }));

  const speakers: CanonicalSpeaker[] = [];
  const seen = new Set<string>();
  for (const turn of ordered) {
    if (seen.has(turn.ref)) {
      continue;
    }
    seen.add(turn.ref);
    speakers.push({
      ref: turn.ref,
      displayName: turn.displayName,
      userId: turn.userId,
      source: turn.source,
    });
  }

  return {
    schemaVersion: 1,
    vendor: input.vendor,
    language: input.language,
    fillerWords: true,
    speakers,
    segments,
    durationMs: input.durationSeconds === null ? null : secondsToMs(input.durationSeconds),
  };
}
