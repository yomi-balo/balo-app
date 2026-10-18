import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useReducedMotion } from 'motion/react';
import { render, screen } from '@/test/utils';
import { Reveal } from './reveal';

/**
 * Real `motion/react`: `useReducedMotion()` is null on the server and true on the client, so the
 * server markup must not depend on it. Driving the real library proves the element tree and its
 * inline `initial` style are identical, not merely that a stub received the same props.
 */
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

function markup(): string {
  return renderToStaticMarkup(
    <Reveal delay={0.1} className="grid">
      <span>Delivery content</span>
    </Reveal>
  );
}

describe('Reveal', () => {
  it('server-renders the same markup whether or not reduced motion is known yet', () => {
    vi.mocked(useReducedMotion).mockReturnValue(null);
    const unresolved = markup();
    vi.mocked(useReducedMotion).mockReturnValue(true);
    expect(markup()).toBe(unresolved);
    expect(unresolved).toContain('opacity:0');
    expect(unresolved).toContain('class="grid"');
  });

  it('renders its children when motion is allowed and when it is reduced', () => {
    for (const reduced of [false, true]) {
      vi.mocked(useReducedMotion).mockReturnValue(reduced);
      const { unmount } = render(
        <Reveal>
          <span>Delivery content</span>
        </Reveal>
      );
      expect(screen.getByText('Delivery content')).toBeInTheDocument();
      unmount();
    }
  });
});
