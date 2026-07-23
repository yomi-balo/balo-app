import { describe, it, expect } from 'vitest';
import { normalizeRecall } from './recall.js';
import {
  recallMultiSpeaker,
  recallMissingSpeaker,
  recallOutOfOrder,
  recallEmpty,
} from './__fixtures__/recall.js';

describe('normalizeRecall', () => {
  it('produces a canonical transcript with both diarized speakers (userId always null)', () => {
    const result = normalizeRecall(recallMultiSpeaker);

    expect(result.schemaVersion).toBe(1);
    expect(result.vendor).toBe('recall');
    expect(result.language).toBe('en');
    expect(result.fillerWords).toBe(true);
    expect(result.durationMs).toBe(10000);

    expect(result.speakers).toHaveLength(2);
    for (const speaker of result.speakers) {
      expect(speaker.source).toBe('diarized');
      expect(speaker.userId).toBeNull(); // Recall never authenticates a Balo user
    }
    expect(result.speakers.map((s) => s.ref)).toEqual(['Speaker 0', 'Speaker 1']);
    expect(result.speakers[0]?.displayName).toBe('Client');
  });

  it('emits ms timestamps and sequential indexes', () => {
    const result = normalizeRecall(recallMultiSpeaker);
    expect(result.segments).toHaveLength(3);
    expect(result.segments.map((s) => s.index)).toEqual([0, 1, 2]);
    const [first] = result.segments;
    expect(first).toMatchObject({
      speakerRef: 'Speaker 0',
      startMs: 0,
      endMs: 2500,
      text: 'Good morning.',
    });
  });

  it('sorts out-of-order utterances by startMs before indexing', () => {
    const result = normalizeRecall(recallOutOfOrder);
    expect(result.segments.map((s) => s.text)).toEqual(['first', 'second', 'third']);
    expect(result.segments.map((s) => s.startMs)).toEqual([0, 3000, 6000]);
  });

  it('maps a missing diarization label to the synthetic "unknown" ref', () => {
    const result = normalizeRecall(recallMissingSpeaker);
    expect(result.segments).toHaveLength(2);
    const unknown = result.speakers.find((s) => s.ref === 'unknown');
    expect(unknown).toBeDefined();
    expect(unknown?.userId).toBeNull();
    expect(unknown?.source).toBe('diarized');
    expect(result.segments[1]?.speakerRef).toBe('unknown');
  });

  it('yields empty speakers + segments for an empty payload', () => {
    const result = normalizeRecall(recallEmpty);
    expect(result.segments).toEqual([]);
    expect(result.speakers).toEqual([]);
    expect(result.durationMs).toBeNull();
  });
});
