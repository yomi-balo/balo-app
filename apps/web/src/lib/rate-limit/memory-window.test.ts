import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkMemoryLimit, __resetMemoryLimitForTests } from './memory-window';

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
});
