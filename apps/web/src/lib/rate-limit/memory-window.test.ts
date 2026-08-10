import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkMemoryLimit,
  __resetMemoryLimitForTests,
  __trackedKeyCountForTests,
} from './memory-window';

describe('checkMemoryLimit', () => {
  beforeEach(() => {
    __resetMemoryLimitForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows hits up to the cap, then blocks within the window', () => {
    const results: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(checkMemoryLimit('ip-a', { max: 3, windowMs: 1000 }));
    }
    expect(results).toEqual([true, true, true, false]);
  });

  it('resets after the window elapses', () => {
    expect(checkMemoryLimit('ip-b', { max: 1, windowMs: 1000 })).toBe(true);
    expect(checkMemoryLimit('ip-b', { max: 1, windowMs: 1000 })).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(checkMemoryLimit('ip-b', { max: 1, windowMs: 1000 })).toBe(true);
  });

  it('tracks distinct keys independently', () => {
    expect(checkMemoryLimit('ip-c', { max: 1, windowMs: 1000 })).toBe(true);
    expect(checkMemoryLimit('ip-c', { max: 1, windowMs: 1000 })).toBe(false);
    // A different key has its own fresh window.
    expect(checkMemoryLimit('ip-d', { max: 1, windowMs: 1000 })).toBe(true);
  });

  it('defaults to 30 hits per 60s window', () => {
    for (let i = 0; i < 30; i += 1) {
      expect(checkMemoryLimit('ip-e')).toBe(true);
    }
    expect(checkMemoryLimit('ip-e')).toBe(false);
  });

  /**
   * ⚠ THE MAP IS BOUNDED. Entries used to expire ONLY lazily, on a later hit for the SAME
   * key, and nothing ever swept — so on a public unauthenticated route, where the key is
   * derived from a spoofable `X-Forwarded-For`, a caller who never repeats a key grew the
   * heap without limit. Sweeping happens on WRITE, which is the path that creates the
   * pressure.
   */
  describe('the bucket map cannot grow without bound', () => {
    it('sweeps EXPIRED buckets on write instead of holding them for a repeat hit', () => {
      for (let i = 0; i < 50; i += 1) {
        checkMemoryLimit(`one-shot-${i}`, { max: 5, windowMs: 1000 });
      }
      expect(__trackedKeyCountForTests()).toBe(50);

      // Every one of those windows has now elapsed, and none of those keys is ever hit
      // again. A single unrelated write must be enough to start reclaiming them.
      vi.advanceTimersByTime(1001);
      checkMemoryLimit('someone-else', { max: 5, windowMs: 1000 });

      expect(__trackedKeyCountForTests()).toBeLessThan(51);
    });

    it('caps the map even when every bucket is still INSIDE its window', () => {
      // A flood of distinct keys inside one window outruns the expiry scan — the overflow
      // eviction is what holds the ceiling. 10_500 > MAX_TRACKED_KEYS (10_000).
      for (let i = 0; i < 10_500; i += 1) {
        checkMemoryLimit(`flood-${i}`, { max: 5, windowMs: 600_000 });
      }
      expect(__trackedKeyCountForTests()).toBeLessThanOrEqual(10_000);
    });

    it('still counts correctly for a key that keeps being hit while others churn', () => {
      expect(checkMemoryLimit('steady', { max: 2, windowMs: 600_000 })).toBe(true);
      for (let i = 0; i < 100; i += 1) {
        checkMemoryLimit(`churn-${i}`, { max: 2, windowMs: 600_000 });
      }
      expect(checkMemoryLimit('steady', { max: 2, windowMs: 600_000 })).toBe(true);
      expect(checkMemoryLimit('steady', { max: 2, windowMs: 600_000 })).toBe(false);
    });
  });
});
