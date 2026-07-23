import { describe, it, expect } from 'vitest';
import { normalizeDailyDeepgram } from './daily-deepgram.js';
import {
  dailyMultiSpeaker,
  dailyMissingSpeaker,
  dailyOutOfOrder,
  dailyEmpty,
} from './__fixtures__/daily-deepgram.js';

describe('normalizeDailyDeepgram', () => {
  it('produces a canonical transcript with both authenticated speakers', () => {
    const result = normalizeDailyDeepgram(dailyMultiSpeaker);

    expect(result.schemaVersion).toBe(1);
    expect(result.vendor).toBe('daily_deepgram');
    expect(result.language).toBe('en');
    expect(result.fillerWords).toBe(true);
    expect(result.durationMs).toBe(12500);

    expect(result.speakers).toHaveLength(2);
    for (const speaker of result.speakers) {
      expect(speaker.source).toBe('authenticated');
      expect(speaker.userId).toBe(speaker.ref); // authenticated ref = userId
    }
    expect(result.speakers.map((s) => s.ref)).toEqual(['user-client-1', 'user-expert-1']);
    expect(result.speakers[0]?.displayName).toBe('Dana Okafor');
  });

  it('emits ms timestamps, sequential indexes, and preserves segment order', () => {
    const result = normalizeDailyDeepgram(dailyMultiSpeaker);

    expect(result.segments).toHaveLength(3);
    expect(result.segments.map((s) => s.index)).toEqual([0, 1, 2]);
    const [first] = result.segments;
    expect(first).toMatchObject({
      speakerRef: 'user-client-1',
      startMs: 0,
      endMs: 3200,
      text: 'Hi, thanks for jumping on.',
      confidence: 0.98,
    });
  });

  it('sorts out-of-order utterances by startMs before indexing', () => {
    const result = normalizeDailyDeepgram(dailyOutOfOrder);
    expect(result.segments.map((s) => s.text)).toEqual(['first', 'second', 'third']);
    expect(result.segments.map((s) => s.startMs)).toEqual([0, 3000, 6000]);
  });

  it('maps a missing speaker to the synthetic "unknown" ref (never drops a segment)', () => {
    const result = normalizeDailyDeepgram(dailyMissingSpeaker);
    expect(result.segments).toHaveLength(2);
    const unknown = result.speakers.find((s) => s.ref === 'unknown');
    expect(unknown).toBeDefined();
    expect(unknown?.userId).toBeNull();
    expect(unknown?.displayName).toBeNull();
    expect(result.segments[1]?.speakerRef).toBe('unknown');
    expect(result.segments[1]?.confidence).toBeNull();
  });

  it('yields empty speakers + segments for an empty payload', () => {
    const result = normalizeDailyDeepgram(dailyEmpty);
    expect(result.segments).toEqual([]);
    expect(result.speakers).toEqual([]);
    expect(result.durationMs).toBeNull();
    expect(result.language).toBeNull();
  });
});
