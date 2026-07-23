import type { DailyDeepgramTranscriptPayload } from '../types.js';

/** Two authenticated speakers, in order. Baseline happy-path fixture. */
export const dailyMultiSpeaker: DailyDeepgramTranscriptPayload = {
  language: 'en',
  durationSeconds: 12.5,
  participants: [
    { userId: 'user-client-1', displayName: 'Dana Okafor' },
    { userId: 'user-expert-1', displayName: 'Priya Nair' },
  ],
  utterances: [
    {
      userId: 'user-client-1',
      start: 0,
      end: 3.2,
      transcript: 'Hi, thanks for jumping on.',
      confidence: 0.98,
    },
    {
      userId: 'user-expert-1',
      start: 3.5,
      end: 7.1,
      transcript: 'Of course — happy to help.',
      confidence: 0.95,
    },
    {
      userId: 'user-client-1',
      start: 7.4,
      end: 12.5,
      transcript: "Let's start with the data model.",
      confidence: 0.9,
    },
  ],
};

/** One utterance with no authenticated user → the synthetic `'unknown'` speaker. */
export const dailyMissingSpeaker: DailyDeepgramTranscriptPayload = {
  language: 'en',
  durationSeconds: 5,
  participants: [{ userId: 'user-expert-1', displayName: 'Priya Nair' }],
  utterances: [
    { userId: 'user-expert-1', start: 0, end: 2, transcript: 'Can you hear me?', confidence: 0.92 },
    { userId: null, start: 2.5, end: 5, transcript: 'Yes, loud and clear.', confidence: null },
  ],
};

/** Utterances out of chronological order → must be sorted by startMs. */
export const dailyOutOfOrder: DailyDeepgramTranscriptPayload = {
  language: 'en',
  durationSeconds: 9,
  participants: [{ userId: 'user-expert-1', displayName: 'Priya Nair' }],
  utterances: [
    { userId: 'user-expert-1', start: 6, end: 9, transcript: 'third', confidence: 0.9 },
    { userId: 'user-expert-1', start: 0, end: 3, transcript: 'first', confidence: 0.9 },
    { userId: 'user-expert-1', start: 3, end: 6, transcript: 'second', confidence: 0.9 },
  ],
};

/** Empty capture → no segments, no speakers. */
export const dailyEmpty: DailyDeepgramTranscriptPayload = {
  language: null,
  durationSeconds: null,
  participants: [],
  utterances: [],
};
