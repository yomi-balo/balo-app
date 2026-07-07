import { describe, it, expect, vi, beforeEach } from 'vitest';

import { render, screen } from '@/test/utils';

// Motion-only props are stripped so React doesn't warn on unknown DOM attrs.
const MOTION_PROPS = new Set(['initial', 'animate', 'transition']);

// `motion/react` is stubbed so we can (a) drive `useReducedMotion` per test and
// (b) mark the animated wrapper, letting us assert WHICH branch `Reveal` took.
const mockUseReducedMotion = vi.hoisted(() => vi.fn());
vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    useReducedMotion: mockUseReducedMotion,
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

import { Reveal } from './reveal';

describe('Reveal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children in a plain wrapper (no animation) when reduced motion is preferred', () => {
    mockUseReducedMotion.mockReturnValue(true);
    render(
      <Reveal>
        <span>Delivery content</span>
      </Reveal>
    );
    expect(screen.getByText('Delivery content')).toBeInTheDocument();
    // Reduced-motion path returns a plain <div> — never the tagged motion wrapper.
    expect(document.querySelector('[data-motion]')).toBeNull();
  });

  it('wraps children in the animated motion wrapper when motion is allowed', () => {
    mockUseReducedMotion.mockReturnValue(false);
    render(
      <Reveal delay={0.1}>
        <span>Delivery content</span>
      </Reveal>
    );
    expect(screen.getByText('Delivery content')).toBeInTheDocument();
    // Motion path renders via the stubbed motion.div (tagged with data-motion).
    expect(document.querySelector('[data-motion]')).not.toBeNull();
  });
});
