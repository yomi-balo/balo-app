import { describe, expect, it } from 'vitest';
import { adaptDailyBatchTranscriptJson } from './daily-batch-json.js';
import {
  batchJsonEmptyUtterancesWithChannels,
  batchJsonNoResults,
  batchJsonNoSpeaker,
  batchJsonTwoSpeakers,
  batchJsonUtterances,
} from './__fixtures__/daily-batch-json.js';

describe('adaptDailyBatchTranscriptJson (BAL-483 §8.2)', () => {
  it('folds consecutive same-speaker words into ONE turn (first start, last end)', () => {
    const result = adaptDailyBatchTranscriptJson(batchJsonTwoSpeakers);

    expect(result.utterances).toHaveLength(2);
    const [first, second] = result.utterances;
    expect(first).toMatchObject({ speakerLabel: 'speaker-0', start: 0, end: 1.1 });
    expect(second).toMatchObject({ speakerLabel: 'speaker-1', start: 3.5, end: 4.6 });
  });

  it('a speaker change starts a new turn', () => {
    const result = adaptDailyBatchTranscriptJson(batchJsonTwoSpeakers);
    expect(result.utterances.map((u) => u.speakerLabel)).toEqual(['speaker-0', 'speaker-1']);
  });

  it('prefers punctuated_word over word when folding text', () => {
    const result = adaptDailyBatchTranscriptJson(batchJsonTwoSpeakers);
    expect(result.utterances[0]?.transcript).toBe('Good morning,');
    expect(result.utterances[1]?.transcript).toBe('Thanks for having me.');
  });

  it('confidence is the arithmetic mean of the folded words', () => {
    const result = adaptDailyBatchTranscriptJson(batchJsonTwoSpeakers);
    // speaker-0: (0.98 + 0.95) / 2 = 0.965
    expect(result.utterances[0]?.confidence).toBeCloseTo(0.965, 5);
  });

  it('confidence is null when no word in the turn has a finite confidence', () => {
    const raw = {
      metadata: {},
      results: {
        channels: [{ alternatives: [{ words: [{ word: 'x', start: 0, end: 1, speaker: 0 }] }] }],
      },
    };
    const result = adaptDailyBatchTranscriptJson(raw);
    expect(result.utterances[0]?.confidence).toBeNull();
  });

  it('speaker: 0 → speakerLabel: "speaker-0"', () => {
    const result = adaptDailyBatchTranscriptJson(batchJsonTwoSpeakers);
    expect(result.utterances[0]?.speakerLabel).toBe('speaker-0');
  });

  it('⚠ a word with NO speaker → speakerLabel: null, and the segment is NOT dropped', () => {
    const result = adaptDailyBatchTranscriptJson(batchJsonNoSpeaker);
    expect(result.utterances).toHaveLength(1);
    expect(result.utterances[0]?.speakerLabel).toBeNull();
    expect(result.utterances[0]?.transcript).toBe('hello there');
  });

  it('results.utterances[] is preferred when present, over the word-fold path', () => {
    const result = adaptDailyBatchTranscriptJson(batchJsonUtterances);
    expect(result.utterances).toHaveLength(2);
    expect(result.utterances.map((u) => u.transcript)).toEqual([
      'Hi, thanks for jumping on.',
      'Of course, happy to help.',
    ]);
    expect(result.utterances.every((u) => u.transcript !== 'ignored')).toBe(true);
  });

  it('⚠⚠ FIX ROUND 1 (M7) — an EMPTY utterances[] falls through to channels, instead of winning on presence alone', () => {
    const result = adaptDailyBatchTranscriptJson(batchJsonEmptyUtterancesWithChannels);
    expect(result.utterances).toHaveLength(1);
    expect(result.utterances[0]?.transcript).toBe('Hello there.');
  });

  it('attribution: "diarized" and participants: [] always', () => {
    const result = adaptDailyBatchTranscriptJson(batchJsonTwoSpeakers);
    expect(result.attribution).toBe('diarized');
    expect(result.participants).toEqual([]);

    const utterancesResult = adaptDailyBatchTranscriptJson(batchJsonUtterances);
    expect(utterancesResult.attribution).toBe('diarized');
    expect(utterancesResult.participants).toEqual([]);
  });

  it('⚠ language is the REQUESTED value, never inferred from the artefact', () => {
    expect(adaptDailyBatchTranscriptJson(batchJsonTwoSpeakers, 'fr').language).toBe('fr');
    expect(adaptDailyBatchTranscriptJson(batchJsonTwoSpeakers).language).toBe('en'); // default
    expect(adaptDailyBatchTranscriptJson(batchJsonTwoSpeakers, null).language).toBeNull();
  });

  it('metadata.duration → durationSeconds, null when absent/non-finite', () => {
    expect(adaptDailyBatchTranscriptJson(batchJsonTwoSpeakers).durationSeconds).toBe(12.5);

    const noDuration = { metadata: {}, results: { utterances: [] } };
    expect(adaptDailyBatchTranscriptJson(noDuration).durationSeconds).toBeNull();

    const negativeDuration = { metadata: { duration: -5 }, results: { utterances: [] } };
    expect(adaptDailyBatchTranscriptJson(negativeDuration).durationSeconds).toBeNull();
  });

  it('⚠⚠ throws on a body with no `results`', () => {
    expect(() => adaptDailyBatchTranscriptJson(batchJsonNoResults)).toThrow();
  });

  it('throws on a wholly unrecognisable body', () => {
    expect(() => adaptDailyBatchTranscriptJson('not an object')).toThrow();
    expect(() => adaptDailyBatchTranscriptJson(null)).toThrow();
  });
});
