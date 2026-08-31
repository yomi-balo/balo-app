import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, render, act } from '@testing-library/react';
import { useTypewriter } from './use-typewriter';

/**
 * BAL-493 fix round 2 (review MAJOR 9, mutation-verified) — `renderHook` flushes effects
 * (inside `act`) before `result.current` is read, so a `result.current` assertion proves only
 * the value AFTER the mount effect ran, never the value the FIRST render actually produced.
 * Replacing `use-typewriter.ts:25`'s `useState(reduced ? (firstPhrase ?? '') : '')` with
 * `useState('')` left the existing "first render" test passing (the mount effect sets the same
 * phrase right after). This records the value computed on every render, in order —
 * `renders[0]` is what actually painted first, which the initializer alone controls (the effect
 * only ever runs AFTER that render).
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

// Mirrors the hook's own internal timing constants exactly (they aren't exported — this is a
// deliberate duplication so each `advanceTimersByTime` call below advances PRECISELY to the
// next scheduled tick, with zero slack. Vitest's fake timers fire every timer whose target
// falls within the advanced window, INCLUDING one a callback schedules mid-advance — so any
// slack beyond one tick's delay risks silently also firing the tick after it, which is exactly
// what an early draft of this file did (a `+32` buffer meant to be generous instead let a
// same-boundary follow-up timer fire too, e.g. jumping straight from "Hi" to "" instead of
// pausing at "H"). Advancing tick-by-tick keeps each assertion pinned to one specific tick.
const TYPE_START_DELAY_MS = 900;
const TYPE_STEP_MS = 32; // TYPE_BASE_MS + 0 * TYPE_JITTER_MS, since Math.random is mocked to 0
const HOLD_MS = 2000;
const ERASE_MS = 14;
const NEXT_PHRASE_DELAY_MS = 360;

describe('useTypewriter', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('under reduced motion: returns phrases[0] on the FIRST render (not just eventually), statically', () => {
    const renders = recordRenders(() => useTypewriter(['Salesforce', 'HubSpot'], true));
    expect(renders[0]).toBe('Salesforce');
  });

  it('under reduced motion with no phrases: returns an empty string', () => {
    const { result } = renderHook(() => useTypewriter([], true));
    expect(result.current).toBe('');
  });

  describe('not reduced', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    // ⚠ `phrases` MUST be a stable reference declared OUTSIDE the `renderHook` callback. That
    // callback re-runs on every state update the hook itself causes (each `setText`), and a
    // fresh array literal on every call would change the effect's dependency identity on every
    // re-render — tearing the in-flight `setTimeout` chain down and restarting it from a cold
    // `TYPE_START_DELAY_MS` every time, rather than letting it progress character by character.

    it('starts empty, then types the first phrase one character at a time', () => {
      const phrases = ['Hi'];
      const { result } = renderHook(() => useTypewriter(phrases, false));
      expect(result.current).toBe('');

      act(() => {
        vi.advanceTimersByTime(TYPE_START_DELAY_MS);
      });
      expect(result.current).toBe('H');

      act(() => {
        vi.advanceTimersByTime(TYPE_STEP_MS);
      });
      expect(result.current).toBe('Hi');
    });

    it('holds the fully-typed phrase, then erases it', () => {
      const phrases = ['Hi'];
      const { result } = renderHook(() => useTypewriter(phrases, false));

      act(() => {
        vi.advanceTimersByTime(TYPE_START_DELAY_MS);
      });
      act(() => {
        vi.advanceTimersByTime(TYPE_STEP_MS);
      });
      expect(result.current).toBe('Hi');

      act(() => {
        vi.advanceTimersByTime(HOLD_MS);
      });
      expect(result.current).toBe('H');
    });

    it('cycles to the next phrase after fully erasing the current one', () => {
      const phrases = ['Hi', 'Yo'];
      const { result } = renderHook(() => useTypewriter(phrases, false));

      // Type 'Hi'.
      act(() => {
        vi.advanceTimersByTime(TYPE_START_DELAY_MS);
      });
      act(() => {
        vi.advanceTimersByTime(TYPE_STEP_MS);
      });
      expect(result.current).toBe('Hi');

      // Hold, then erase both characters.
      act(() => {
        vi.advanceTimersByTime(HOLD_MS);
      });
      expect(result.current).toBe('H');
      act(() => {
        vi.advanceTimersByTime(ERASE_MS);
      });
      expect(result.current).toBe('');

      // Cycle to 'Yo'.
      act(() => {
        vi.advanceTimersByTime(NEXT_PHRASE_DELAY_MS);
      });
      expect(result.current).toBe('Y');
      act(() => {
        vi.advanceTimersByTime(TYPE_STEP_MS);
      });
      expect(result.current).toBe('Yo');
    });
  });
});
