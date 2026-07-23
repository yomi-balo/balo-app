import type { RecallTranscriptPayload } from '../types.js';

/** Two diarized speakers, in order. Baseline happy-path fixture. */
export const recallMultiSpeaker: RecallTranscriptPayload = {
  language: 'en',
  durationSeconds: 10,
  speakers: [
    { label: 'Speaker 0', displayName: 'Client' },
    { label: 'Speaker 1', displayName: 'Expert' },
  ],
  utterances: [
    { speaker: 'Speaker 0', start: 0, end: 2.5, text: 'Good morning.', confidence: 0.88 },
    {
      speaker: 'Speaker 1',
      start: 2.8,
      end: 6,
      text: 'Morning — shall we begin?',
      confidence: 0.91,
    },
    { speaker: 'Speaker 0', start: 6.2, end: 10, text: 'Yes, please.', confidence: 0.87 },
  ],
};

/** One utterance with no diarization label → the synthetic `'unknown'` speaker. */
export const recallMissingSpeaker: RecallTranscriptPayload = {
  language: 'en',
  durationSeconds: 4,
  speakers: [{ label: 'Speaker 0', displayName: null }],
  utterances: [
    { speaker: 'Speaker 0', start: 0, end: 2, text: 'Is anyone there?', confidence: 0.8 },
    { speaker: null, start: 2, end: 4, text: 'Here.', confidence: null },
  ],
};

/** Utterances out of chronological order → must be sorted by startMs. */
export const recallOutOfOrder: RecallTranscriptPayload = {
  language: 'en',
  durationSeconds: 9,
  speakers: [{ label: 'Speaker 0', displayName: null }],
  utterances: [
    { speaker: 'Speaker 0', start: 6, end: 9, text: 'third', confidence: 0.9 },
    { speaker: 'Speaker 0', start: 0, end: 3, text: 'first', confidence: 0.9 },
    { speaker: 'Speaker 0', start: 3, end: 6, text: 'second', confidence: 0.9 },
  ],
};

/** Empty capture → no segments, no speakers. */
export const recallEmpty: RecallTranscriptPayload = {
  language: null,
  durationSeconds: null,
  speakers: [],
  utterances: [],
};
