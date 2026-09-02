/**
 * BAL-483 (§14) — docs-derived Daily Batch Processor `json` artefact fixtures. The word shapes
 * mirror Daily's own documented sample (`docs.daily.co/reference/rest-api/batch-processor`,
 * "Example transcripts / JSON" block): `{ word, start, end, confidence, speaker,
 * speaker_confidence, punctuated_word }`.
 */

/** Two speakers, punctuated words, `metadata.duration` — the word-fold happy path. */
export const batchJsonTwoSpeakers = {
  metadata: { duration: 12.5, channels: 1 },
  results: {
    channels: [
      {
        alternatives: [
          {
            words: [
              {
                word: 'good',
                punctuated_word: 'Good',
                start: 0,
                end: 0.5,
                confidence: 0.98,
                speaker: 0,
                speaker_confidence: 0.9,
              },
              {
                word: 'morning',
                punctuated_word: 'morning,',
                start: 0.5,
                end: 1.1,
                confidence: 0.95,
                speaker: 0,
                speaker_confidence: 0.9,
              },
              {
                word: 'thanks',
                punctuated_word: 'Thanks',
                start: 3.5,
                end: 3.9,
                confidence: 0.9,
                speaker: 1,
                speaker_confidence: 0.4,
              },
              {
                word: 'for',
                punctuated_word: 'for',
                start: 3.9,
                end: 4.1,
                confidence: 0.92,
                speaker: 1,
                speaker_confidence: 0.4,
              },
              {
                word: 'having',
                punctuated_word: 'having',
                start: 4.1,
                end: 4.4,
                confidence: 0.88,
                speaker: 1,
                speaker_confidence: 0.4,
              },
              {
                word: 'me',
                punctuated_word: 'me.',
                start: 4.4,
                end: 4.6,
                confidence: 0.93,
                speaker: 1,
                speaker_confidence: 0.4,
              },
            ],
          },
        ],
      },
    ],
  },
};

/** A word with NO `speaker` field at all → the synthetic `null` label, never dropped. */
export const batchJsonNoSpeaker = {
  metadata: { duration: 2 },
  results: {
    channels: [
      {
        alternatives: [
          {
            words: [
              { word: 'hello', start: 0, end: 0.5, confidence: 0.9 },
              { word: 'there', start: 0.5, end: 1, confidence: 0.85 },
            ],
          },
        ],
      },
    ],
  },
};

/** `results.utterances[]` present — the preferred shape over the word-fold path. */
export const batchJsonUtterances = {
  metadata: { duration: 9 },
  results: {
    utterances: [
      { start: 0, end: 3, transcript: 'Hi, thanks for jumping on.', confidence: 0.97, speaker: 0 },
      {
        start: 3.2,
        end: 6.5,
        transcript: 'Of course, happy to help.',
        confidence: 0.94,
        speaker: 1,
      },
    ],
    // A word-shaped channel is ALSO present, to prove utterances win when both exist.
    channels: [
      {
        alternatives: [{ words: [{ word: 'ignored', start: 0, end: 1, speaker: 5 }] }],
      },
    ],
  },
};

/** No `results` key at all — must throw. */
export const batchJsonNoResults = { metadata: { duration: 5 } };

/**
 * FIX ROUND 4 (M1 nit) — every `results.utterances[]` entry carries empty/whitespace-only
 * `transcript` text. Must adapt to ZERO turns, so `handleIngest`'s existing
 * `payload.utterances.length === 0` guard catches it — the same junk-recap shape M1 exists to
 * prevent, reached through a source that PASSES the length check on the raw array.
 */
export const batchJsonUtterancesAllEmptyText = {
  metadata: { duration: 4 },
  results: {
    utterances: [
      { start: 0, end: 1, transcript: '', confidence: 0.9, speaker: 0 },
      { start: 1, end: 2, transcript: '   ', confidence: 0.8, speaker: 1 },
    ],
  },
};

/** FIX ROUND 4 — a MIXED `results.utterances[]`: only the empty/whitespace-only entries drop. */
export const batchJsonUtterancesMixedEmptyText = {
  metadata: { duration: 6 },
  results: {
    utterances: [
      { start: 0, end: 1, transcript: '', confidence: 0.9, speaker: 0 },
      { start: 1, end: 2, transcript: 'hello there', confidence: 0.8, speaker: 1 },
      { start: 2, end: 3, transcript: '   ', confidence: 0.7, speaker: 0 },
    ],
  },
};

/**
 * FIX ROUND 1 (M7) — `results.utterances: []` alongside a POPULATED `channels`. Before the
 * fix, `results.utterances !== undefined` alone won this and yielded ZERO turns even though
 * the word-fold path had real content. Must fall through to `channels`.
 */
export const batchJsonEmptyUtterancesWithChannels = {
  metadata: { duration: 4 },
  results: {
    utterances: [],
    channels: [
      {
        alternatives: [
          {
            words: [
              { word: 'hello', punctuated_word: 'Hello', start: 0, end: 0.4, speaker: 0 },
              { word: 'there', punctuated_word: 'there.', start: 0.4, end: 0.8, speaker: 0 },
            ],
          },
        ],
      },
    ],
  },
};
