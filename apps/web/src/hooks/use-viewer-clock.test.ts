import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ViewerClock } from './use-viewer-clock';
import { useViewerClock, VIEWER_CLOCK_TICK_MS } from './use-viewer-clock';

const FIXED_NOW = new Date('2026-09-17T10:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ now: FIXED_NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useViewerClock (BAL-566 D10/R3)', () => {
  it('is null on the first render (identical to the server pass — no hydration mismatch)', () => {
    // Record EVERY render's value — `renderHook` flushes the mount effect inside its own `act()`,
    // so by the time it returns, `result.current` already reflects the POST-effect value and can
    // never prove what render 0 looked like. Pushing into `seen` from inside the rendered
    // function captures the value at each render, including the one that happens before the
    // effect has run.
    const seen: (ViewerClock | null)[] = [];
    renderHook(() => {
      const clock = useViewerClock();
      seen.push(clock);
      return clock;
    });

    expect(seen.length).toBeGreaterThan(1); // non-vacuity: the effect must have caused a re-render
    expect(seen[0]).toBeNull();
    const [, second] = seen;
    expect(second).not.toBeNull();
  });

  it('resolves to { now, timeZone } after the effect runs', () => {
    const { result } = renderHook(() => useViewerClock());
    expect(result.current?.now).toBeInstanceOf(Date);
    expect(typeof result.current?.timeZone).toBe('string');
    expect(result.current?.timeZone.length).toBeGreaterThan(0);
  });

  it('re-ticks every VIEWER_CLOCK_TICK_MS', () => {
    const { result } = renderHook(() => useViewerClock());
    const first = result.current?.now.getTime();
    act(() => {
      vi.advanceTimersByTime(VIEWER_CLOCK_TICK_MS);
    });
    const second = result.current?.now.getTime();
    expect(second).toBeGreaterThan(first ?? 0);
  });

  it('clears its interval on unmount (no further ticks / no leak)', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderHook(() => useViewerClock());
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
