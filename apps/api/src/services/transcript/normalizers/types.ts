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
  /**
   * BAL-483 — the DIARIZATION label (`'speaker-0'`, …) when `attribution === 'diarized'`.
   * ⚠ MUTUALLY EXCLUSIVE WITH `userId`: an ordinal is not an identity, and the diarized arm
   * writes `CanonicalSpeaker.userId = null` precisely so no Balo user is implied.
   */
  speakerLabel?: string | null;
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
  /**
   * BAL-483 — which attribution model produced `utterances`.
   * `'authenticated'` (the DEFAULT when absent — the real-time capture path, and every
   * pre-BAL-483 fixture) rides the Daily `user_id` claim.
   * `'diarized'` (the post-call Batch Processor path) rides an ordinal-derived
   * `speakerLabel` and asserts NO Balo user.
   * ⚠ OPTIONAL AND ABSENT-BY-DEFAULT SO NO EXISTING FIXTURE CHANGES BEHAVIOUR — the
   * `normalizeVendorPayload` enum dispatch stays a single arm per vendor.
   */
  attribution?: 'authenticated' | 'diarized';
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
