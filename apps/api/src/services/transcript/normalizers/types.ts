/**
 * BAL-387 (ADR-1013) — pure vendor payload TYPE definitions. NO SDK: BAL-126/BAL-140
 * (the Daily/Recall capture producers) are unbuilt, so the normalizers are pure functions
 * over minimal, realistic payload shapes rather than a vendor client's response types.
 *
 * Both vendors express timestamps in SECONDS (Deepgram + Recall convention); the
 * normalizers coerce them to ms for the canonical schema. A missing speaker (absent /
 * empty attribution) maps to the synthetic `'unknown'` ref — a segment is never dropped.
 */

// ── Daily-native Deepgram (Balo Video) — authenticated `userId` attribution ──

export interface DailyDeepgramParticipant {
  /** Authenticated Balo user id for this Daily participant. */
  userId: string;
  displayName: string | null;
}

export interface DailyDeepgramUtterance {
  /** Authenticated speaker user id; absent/empty → the synthetic `'unknown'` speaker. */
  userId: string | null;
  start: number; // seconds
  end: number; // seconds
  transcript: string;
  confidence: number | null;
}

export interface DailyDeepgramTranscriptPayload {
  language: string | null;
  durationSeconds: number | null;
  participants: DailyDeepgramParticipant[];
  utterances: DailyDeepgramUtterance[];
}

// ── Recall bot (external venues) — name-diarization attribution ──

export interface RecallDiarizedSpeaker {
  /** Diarization label, e.g. `"Speaker 0"` (stable within the transcript). */
  label: string;
  displayName: string | null;
}

export interface RecallUtterance {
  /** Diarization label; absent/empty → the synthetic `'unknown'` speaker. */
  speaker: string | null;
  start: number; // seconds
  end: number; // seconds
  text: string;
  confidence: number | null;
}

export interface RecallTranscriptPayload {
  language: string | null;
  durationSeconds: number | null;
  speakers: RecallDiarizedSpeaker[];
  utterances: RecallUtterance[];
}
