import { describe, it, expect } from 'vitest';
import { RATE_LIMIT_BUCKETS } from '@balo/shared/rate-limit';
import { WEB_RATE_LIMIT_BUCKET_CONFIGS } from './buckets.js';

/**
 * Pins the bucket numbers (BAL-461) so a change to a limit is deliberate, and pins the
 * key-set/shape invariants the route depends on: a config for every shared bucket name, and no
 * two buckets sharing a Redis key prefix.
 */
describe('WEB_RATE_LIMIT_BUCKET_CONFIGS', () => {
  it('has exactly one config per bucket name in the shared tuple — no more, no fewer', () => {
    expect(Object.keys(WEB_RATE_LIMIT_BUCKET_CONFIGS).sort((a, b) => a.localeCompare(b))).toEqual(
      [...RATE_LIMIT_BUCKETS].sort((a, b) => a.localeCompare(b))
    );
  });

  it('every keyPrefix is ratelimit:web:<bucket>:user', () => {
    for (const bucket of RATE_LIMIT_BUCKETS) {
      expect(WEB_RATE_LIMIT_BUCKET_CONFIGS[bucket].keyPrefix).toBe(`ratelimit:web:${bucket}:user`);
    }
  });

  it('every keyPrefix is unique — no bucket collides with another', () => {
    const prefixes = RATE_LIMIT_BUCKETS.map(
      (bucket) => WEB_RATE_LIMIT_BUCKET_CONFIGS[bucket].keyPrefix
    );
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('every bucket uses a 60-second window', () => {
    for (const bucket of RATE_LIMIT_BUCKETS) {
      expect(WEB_RATE_LIMIT_BUCKET_CONFIGS[bucket].windowSeconds).toBe(60);
    }
  });

  // Pinned so a limit change is deliberate, not accidental.
  it.each([
    ['meeting-chat-post', 30],
    ['meeting-chat-read', 60],
    ['meeting-reaction', 120],
    ['meeting-realtime-token', 30],
    ['typing-signal', 120],
    ['proposal-pdf', 30],
  ] as const)('%s allows %i requests per window', (bucket, maxRequests) => {
    expect(WEB_RATE_LIMIT_BUCKET_CONFIGS[bucket].maxRequests).toBe(maxRequests);
  });
});
