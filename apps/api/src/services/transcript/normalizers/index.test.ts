import { describe, it, expect } from 'vitest';
import { normalizeVendorPayload } from './index.js';
import { dailyMultiSpeaker } from './__fixtures__/daily-deepgram.js';
import { recallMultiSpeaker } from './__fixtures__/recall.js';

describe('normalizeVendorPayload', () => {
  it('routes daily_deepgram to the authenticated-attribution normalizer', () => {
    const result = normalizeVendorPayload('daily_deepgram', dailyMultiSpeaker);
    expect(result.vendor).toBe('daily_deepgram');
    expect(result.speakers.every((s) => s.source === 'authenticated')).toBe(true);
  });

  it('routes recall to the diarized-attribution normalizer', () => {
    const result = normalizeVendorPayload('recall', recallMultiSpeaker);
    expect(result.vendor).toBe('recall');
    expect(result.speakers.every((s) => s.source === 'diarized')).toBe(true);
  });

  it('throws on an unknown vendor', () => {
    expect(() =>
      // @ts-expect-error — exercising the exhaustive-guard runtime path
      normalizeVendorPayload('zoom', dailyMultiSpeaker)
    ).toThrow(/Unknown transcript vendor/);
  });
});
