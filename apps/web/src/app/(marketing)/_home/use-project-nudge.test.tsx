import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useProjectNudge, type UseProjectNudgeOptions } from './use-project-nudge';

// Trimmed length 37, scores 5: +3 for the `implement\w*` build verb, +2 for the `across` scale
// word — comfortably above PROJECT_NUDGE_THRESHOLD (3).
const ELIGIBLE_QUERY = 'implement CPQ across our support team';
// Trimmed length 12 (< 18) — scores 0 outright regardless of content.
const TOO_SHORT_QUERY = 'fix a bug';
// A consultation-shaped query: scores below the threshold (the -3 signal dominates).
const INELIGIBLE_QUERY = 'why does my report not load and how do I fix it';

function renderNudge(initial: UseProjectNudgeOptions) {
  return renderHook((props: UseProjectNudgeOptions) => useProjectNudge(props), {
    initialProps: initial,
  });
}

describe('useProjectNudge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays hidden at 499ms and shows at exactly 500ms after becoming eligible', () => {
    const onShown = vi.fn();
    const { result } = renderNudge({
      query: ELIGIBLE_QUERY,
      productCount: 0,
      active: true,
      onShown,
    });

    expect(result.current.visible).toBe(false);

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current.visible).toBe(false);
    expect(onShown).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.visible).toBe(true);
    expect(onShown).toHaveBeenCalledTimes(1);
    expect(onShown).toHaveBeenCalledWith(5);
  });

  it('never shows a query under 18 trimmed characters, even once active and past the delay', () => {
    const onShown = vi.fn();
    const { result } = renderNudge({
      query: TOO_SHORT_QUERY,
      productCount: 0,
      active: true,
      onShown,
    });

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.visible).toBe(false);
    expect(result.current.score).toBe(0);
    expect(onShown).not.toHaveBeenCalled();
  });

  it('hides immediately (no debounce) when active flips false, even mid-eligible', () => {
    const onShown = vi.fn();
    const { result, rerender } = renderNudge({
      query: ELIGIBLE_QUERY,
      productCount: 0,
      active: true,
      onShown,
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.visible).toBe(true);

    rerender({ query: ELIGIBLE_QUERY, productCount: 0, active: false, onShown });
    expect(result.current.visible).toBe(false);
  });

  it('hides immediately when the query changes to a consultation-shaped (below-threshold) one', () => {
    const onShown = vi.fn();
    const { result, rerender } = renderNudge({
      query: ELIGIBLE_QUERY,
      productCount: 0,
      active: true,
      onShown,
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.visible).toBe(true);

    rerender({ query: INELIGIBLE_QUERY, productCount: 0, active: true, onShown });
    // Hiding is synchronous with the render that makes it ineligible — no timer advance needed.
    expect(result.current.visible).toBe(false);
  });

  it('stays visible while typing (still eligible) and fires onShown exactly once', () => {
    const onShown = vi.fn();
    const { result, rerender } = renderNudge({
      query: ELIGIBLE_QUERY,
      productCount: 0,
      active: true,
      onShown,
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.visible).toBe(true);
    expect(onShown).toHaveBeenCalledTimes(1);

    // Keep typing — still well above the threshold.
    const extended = `${ELIGIBLE_QUERY} across two business units`;
    rerender({ query: extended, productCount: 0, active: true, onShown });
    expect(result.current.visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.visible).toBe(true);
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it('a score that dips below the threshold and recovers counts as a NEW show', () => {
    const onShown = vi.fn();
    const { result, rerender } = renderNudge({
      query: ELIGIBLE_QUERY,
      productCount: 0,
      active: true,
      onShown,
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.visible).toBe(true);
    expect(onShown).toHaveBeenCalledTimes(1);

    rerender({ query: INELIGIBLE_QUERY, productCount: 0, active: true, onShown });
    expect(result.current.visible).toBe(false);

    rerender({ query: ELIGIBLE_QUERY, productCount: 0, active: true, onShown });
    expect(result.current.visible).toBe(false);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.visible).toBe(true);
    expect(onShown).toHaveBeenCalledTimes(2);
  });

  it('dismissal hides the nudge until the query is cleared to empty', () => {
    const onShown = vi.fn();
    const { result, rerender } = renderNudge({
      query: ELIGIBLE_QUERY,
      productCount: 0,
      active: true,
      onShown,
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.visible).toBe(true);

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.visible).toBe(false);

    // Still typing the same (or a different, still-eligible) query — dismissal persists.
    rerender({ query: `${ELIGIBLE_QUERY}!`, productCount: 0, active: true, onShown });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.visible).toBe(false);

    // Clearing the query lifts the dismissal.
    rerender({ query: '', productCount: 0, active: true, onShown });
    rerender({ query: ELIGIBLE_QUERY, productCount: 0, active: true, onShown });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.visible).toBe(true);
  });

  it('never takes focus and exposes the live score for the CTA/dismiss analytics payloads', () => {
    const onShown = vi.fn();
    const { result } = renderNudge({
      query: ELIGIBLE_QUERY,
      productCount: 0,
      active: true,
      onShown,
    });
    // The hook renders no DOM at all — it is pure state, so there is nothing that could steal
    // focus. `document.activeElement` is untouched by mounting it.
    const before = document.activeElement;
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.activeElement).toBe(before);
    expect(result.current.score).toBe(5);
  });
});
