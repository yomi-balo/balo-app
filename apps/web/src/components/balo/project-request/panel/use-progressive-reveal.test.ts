import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Control `useReducedMotion` so both the normal and reduced-motion branches are covered — same
// pattern as `components/search/results-grid.test.tsx`.
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

import { useReducedMotion } from 'motion/react';
import { useProgressiveReveal } from './use-progressive-reveal';

const mockReducedMotion = vi.mocked(useReducedMotion);

const THREE_BLOCK_HTML = '<h2>Problem</h2><p>One</p><p>Two</p>';

describe('useProgressiveReveal', () => {
  beforeEach(() => {
    mockReducedMotion.mockReturnValue(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reveals nothing for a null html', () => {
    const { result } = renderHook(() => useProgressiveReveal(null, 0));
    expect(result.current.revealing).toBe(false);
    expect(result.current.visibleHtml).toBe('');
  });

  it('reveals nothing for an empty string', () => {
    const { result } = renderHook(() => useProgressiveReveal('', 0));
    expect(result.current.revealing).toBe(false);
    expect(result.current.visibleHtml).toBe('');
  });

  it('reveals one top-level block at a time, 120ms apart', async () => {
    const { result } = renderHook(() => useProgressiveReveal(THREE_BLOCK_HTML, 0));

    expect(result.current.revealing).toBe(true);
    expect(result.current.visibleHtml).toBe('');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(result.current.visibleHtml).toBe('<h2>Problem</h2>');
    expect(result.current.revealing).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(result.current.visibleHtml).toBe('<h2>Problem</h2><p>One</p>');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(result.current.visibleHtml).toBe('<h2>Problem</h2><p>One</p><p>Two</p>');
    expect(result.current.revealing).toBe(false);
  });

  it('stops incrementing once every block is visible', async () => {
    const { result } = renderHook(() => useProgressiveReveal(THREE_BLOCK_HTML, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120 * 10);
    });
    expect(result.current.revealing).toBe(false);
    expect(result.current.visibleHtml).toBe(THREE_BLOCK_HTML);
  });

  it('reveals a block-less string (plain text) as a single block', async () => {
    const { result } = renderHook(() => useProgressiveReveal('just text, no tags', 0));
    expect(result.current.revealing).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(result.current.visibleHtml).toBe('just text, no tags');
    expect(result.current.revealing).toBe(false);
  });

  it('reveals everything instantly under prefers-reduced-motion', () => {
    mockReducedMotion.mockReturnValue(true);
    const { result } = renderHook(() => useProgressiveReveal(THREE_BLOCK_HTML, 0));
    expect(result.current.revealing).toBe(false);
    expect(result.current.visibleHtml).toBe(THREE_BLOCK_HTML);
  });

  it('a bumped runKey restarts the reveal even for the identical html string', async () => {
    const { result, rerender } = renderHook(
      ({ runKey }) => useProgressiveReveal(THREE_BLOCK_HTML, runKey),
      {
        initialProps: { runKey: 0 },
      }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120 * 10);
    });
    expect(result.current.visibleHtml).toBe(THREE_BLOCK_HTML);

    rerender({ runKey: 1 });
    expect(result.current.revealing).toBe(true);
    expect(result.current.visibleHtml).toBe('');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120 * 10);
    });
    expect(result.current.visibleHtml).toBe(THREE_BLOCK_HTML);
  });

  it('a new html value restarts the reveal from zero', async () => {
    const { result, rerender } = renderHook(({ html }) => useProgressiveReveal(html, 0), {
      initialProps: { html: '<p>First</p>' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(result.current.visibleHtml).toBe('<p>First</p>');
    expect(result.current.revealing).toBe(false);

    rerender({ html: '<p>Second</p><p>Third</p>' });
    expect(result.current.revealing).toBe(true);
    expect(result.current.visibleHtml).toBe('');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120 * 5);
    });
    expect(result.current.visibleHtml).toBe('<p>Second</p><p>Third</p>');
  });

  // Reset happens DURING RENDER, not from the effect.
  it('a redraft with FEWER blocks than the previous run starts from zero', async () => {
    const { result, rerender } = renderHook(
      ({ html, runKey }) => useProgressiveReveal(html, runKey),
      { initialProps: { html: THREE_BLOCK_HTML, runKey: 0 } }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120 * 10);
    });
    expect(result.current.visibleHtml).toBe(THREE_BLOCK_HTML);

    rerender({ html: '<p>Only one block</p>', runKey: 1 });
    // Pinned WITHOUT advancing any timer — the reset must already be visible on this very
    // render, not only once the effect below has had a chance to run.
    expect(result.current.revealing).toBe(true);
    expect(result.current.visibleHtml).toBe('');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(result.current.visibleHtml).toBe('<p>Only one block</p>');
    expect(result.current.revealing).toBe(false);
  });

  it('clears the interval on unmount', async () => {
    const { result, unmount } = renderHook(() => useProgressiveReveal(THREE_BLOCK_HTML, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    const midReveal = result.current.visibleHtml;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120 * 10);
    });
    // Nothing throws, and the last-known value is unchanged (no further ticks landed anywhere).
    expect(midReveal).toBe('<h2>Problem</h2>');
  });
});
