import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, render } from '@testing-library/react';
import { useCountUp } from './use-count-up';

/**
 * BAL-493 fix round 2 (review MAJOR 9, mutation-verified) — `renderHook` flushes effects
 * (inside `act`) before `result.current` is read, so a `result.current` assertion proves only
 * the value AFTER the mount effect ran, never the value the FIRST render actually produced.
 * Replacing `use-count-up.ts:25`'s `useState(reduced ? target : 0)` with `useState(0)` left
 * every existing test passing (the mount effect sets the same target value right after). This
 * records the value computed on every render, in order — `renders[0]` is what actually painted
 * first, which the initializer alone controls (the effect only ever runs AFTER that render).
 */
function recordRenders<T>(useHookValue: () => T): T[] {
  const renders: T[] = [];
  function Recorder(): null {
    renders.push(useHookValue());
    return null;
  }
  render(<Recorder />);
  return renders;
}

describe('useCountUp', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('under reduced motion: returns the target on the FIRST render (not just eventually), with no rAF scheduled', () => {
    const rafSpy = vi.fn();
    vi.stubGlobal('requestAnimationFrame', rafSpy);

    const renders = recordRenders(() => useCountUp(1234, true, true, 0));

    expect(renders[0]).toBe('1234');
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('applies the requested decimal precision under reduced motion', () => {
    const { result } = renderHook(() => useCountUp(4.5, true, true, 1));
    expect(result.current).toBe('4.5');
  });

  it('when inactive: stays at 0 and schedules no animation frame', () => {
    const rafSpy = vi.fn();
    vi.stubGlobal('requestAnimationFrame', rafSpy);

    const { result } = renderHook(() => useCountUp(100, false, false, 0));

    expect(result.current).toBe('0');
    expect(rafSpy).not.toHaveBeenCalled();
  });

  describe('active, not reduced', () => {
    beforeEach(() => {
      // Each rAF call advances a monotonic timestamp by 700ms, so the eased ramp inside
      // `useCountUp` (default 1400ms duration) resolves to `progress === 1` after three
      // synchronous, recursive calls — deterministic without real timers.
      let timestamp = 0;
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        timestamp += 700;
        cb(timestamp);
        return 0;
      });
      vi.stubGlobal('cancelAnimationFrame', () => {});
    });

    it('ramps to the target value', () => {
      const { result } = renderHook(() => useCountUp(1400, true, false, 0));
      expect(result.current).toBe('1400');
    });
  });
});
