import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useReducedMotion } from 'motion/react';
import { render, screen } from '@/test/utils';
import { StateSwap } from './state-swap';

/**
 * Real `motion/react`: `useReducedMotion()` is null on the server and true on the client, so the
 * server markup must not depend on it (see `engagement/reveal.test.tsx`).
 */
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

function markup(): string {
  return renderToStaticMarkup(
    <StateSwap swapKey="ask" className="flex">
      <span>Is this issue resolved?</span>
    </StateSwap>
  );
}

describe('StateSwap', () => {
  it('server-renders the same markup whether or not reduced motion is known yet', () => {
    vi.mocked(useReducedMotion).mockReturnValue(null);
    const unresolved = markup();
    vi.mocked(useReducedMotion).mockReturnValue(true);
    expect(markup()).toBe(unresolved);
    expect(unresolved).toContain('class="flex"');
    expect(unresolved).toContain('Is this issue resolved?');
  });

  it('renders its children under both motion preferences, with or without a className', () => {
    for (const reduced of [false, true]) {
      vi.mocked(useReducedMotion).mockReturnValue(reduced);
      const { unmount } = render(
        <StateSwap swapKey="acknowledged">
          <span>No problem</span>
        </StateSwap>
      );
      expect(screen.getByText('No problem')).toBeInTheDocument();
      unmount();
    }
  });
});
