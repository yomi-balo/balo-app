import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

/**
 * `StateSwap` owns TWO branches and the reduced-motion one is invisible to every consumer test
 * (the shared stub reports `useReducedMotion: () => false`), so it gets direct coverage here.
 * The stub is driven per test, exactly as `reveal.test.tsx` drives it for `Reveal`.
 */
const MOTION_PROPS = new Set(['initial', 'animate', 'exit', 'transition']);

const mockUseReducedMotion = vi.hoisted(() => vi.fn());
vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    useReducedMotion: mockUseReducedMotion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-presence': 'true' }, children),
    motion: new Proxy(
      {},
      {
        get: (_t: unknown, tag: string) =>
          function MotionStub(props: Record<string, unknown>) {
            const filtered: Record<string, unknown> = { 'data-motion': 'true' };
            for (const [key, value] of Object.entries(props)) {
              if (!MOTION_PROPS.has(key)) filtered[key] = value;
            }
            return React.createElement(tag, filtered);
          },
      }
    ),
  };
});

import { StateSwap } from './state-swap';

describe('StateSwap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders children in a plain wrapper, with no AnimatePresence, under reduced motion', () => {
    mockUseReducedMotion.mockReturnValue(true);
    const { container } = render(
      <StateSwap swapKey="ask" className="flex">
        <span>Is this issue resolved?</span>
      </StateSwap>
    );
    expect(screen.getByText('Is this issue resolved?')).toBeInTheDocument();
    expect(container.querySelector('[data-presence]')).toBeNull();
    expect(container.querySelector('[data-motion]')).toBeNull();
    // ⚠ The LAYOUT is identical either way — only the entrance transform is dropped.
    expect(container.querySelector('.flex')).not.toBeNull();
  });

  it('wraps children in AnimatePresence + a motion element when motion is allowed', () => {
    mockUseReducedMotion.mockReturnValue(false);
    const { container } = render(
      <StateSwap swapKey="done" className="flex">
        <span>Case closed.</span>
      </StateSwap>
    );
    expect(screen.getByText('Case closed.')).toBeInTheDocument();
    expect(container.querySelector('[data-presence]')).not.toBeNull();
    expect(container.querySelector('[data-motion]')).not.toBeNull();
    expect(container.querySelector('.flex')).not.toBeNull();
  });

  it('keeps rendering without a className', () => {
    mockUseReducedMotion.mockReturnValue(true);
    render(
      <StateSwap swapKey="acknowledged">
        <span>No problem</span>
      </StateSwap>
    );
    expect(screen.getByText('No problem')).toBeInTheDocument();
  });
});
