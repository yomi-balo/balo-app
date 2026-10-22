import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { VIEWER_CLOCK_TICK_MS } from '@/hooks/use-viewer-clock';
import { useNowTick } from './use-now-tick';

describe('useNowTick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at the current time and advances on every tick interval', () => {
    const { result } = renderHook(() => useNowTick());
    expect(result.current.toISOString()).toBe('2026-06-01T00:00:00.000Z');

    act(() => {
      vi.advanceTimersByTime(VIEWER_CLOCK_TICK_MS);
    });

    expect(result.current.toISOString()).toBe('2026-06-01T00:01:00.000Z');
  });

  it.each([
    ['visibilitychange', document],
    ['focus', globalThis],
    ['pageshow', globalThis],
  ] as const)('re-reads the clock immediately on %s', (eventName, target) => {
    const { result } = renderHook(() => useNowTick());

    act(() => {
      vi.setSystemTime(new Date('2026-06-01T00:00:30.000Z'));
      target.dispatchEvent(new Event(eventName));
    });

    expect(result.current.toISOString()).toBe('2026-06-01T00:00:30.000Z');
  });

  it('removes its listeners and timer on unmount', () => {
    const removeDoc = vi.spyOn(document, 'removeEventListener');
    const removeWin = vi.spyOn(globalThis, 'removeEventListener');
    const { unmount } = renderHook(() => useNowTick());

    unmount();

    expect(removeDoc).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(removeWin).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(removeWin).toHaveBeenCalledWith('pageshow', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
