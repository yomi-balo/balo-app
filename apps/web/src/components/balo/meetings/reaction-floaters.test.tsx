import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { ReactionFloater } from './use-meeting-realtime';
import { ReactionFloaters } from './reaction-floaters';

/**
 * BAL-437 — the floating reaction layer.
 *
 * ⚠⚠ THE TWO PROPERTIES HERE ARE **CORRECTNESS**, NOT POLISH:
 *
 *   · `pointer-events-none` — this layer covers the whole stage. Without it, it eats every
 *     click on the video (the spotlight swap, the overflow tile, the stage controls) for the
 *     2.2 seconds a reaction is in flight, on a LIVE CALL.
 *   · `aria-hidden` — a floater is a transient decoration. A screen reader announcing "thumbs
 *     up" six times while somebody is speaking is a denial of service, and §16 reserves the ONE
 *     polite live region for mutation outcomes.
 */

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

function floater(nonce: string, emoji: ReactionFloater['emoji']): ReactionFloater {
  return { nonce, emoji };
}

describe('ReactionFloaters', () => {
  it('renders one node per floater', () => {
    render(<ReactionFloaters floaters={[floater('a', '👍'), floater('b', '🎉')]} />);

    const layer = screen.getByTestId('reaction-floaters');
    expect(layer.textContent).toBe('👍🎉');
  });

  it('⚠⚠ is `pointer-events-none` — otherwise it eats every click on the live video', () => {
    render(<ReactionFloaters floaters={[floater('a', '👍')]} />);

    expect([...screen.getByTestId('reaction-floaters').classList]).toContain('pointer-events-none');
  });

  it('⚠⚠ is `aria-hidden` — a transient decoration, never an announcement', () => {
    render(<ReactionFloaters floaters={[floater('a', '👍')]} />);

    expect(screen.getByTestId('reaction-floaters')).toHaveAttribute('aria-hidden', 'true');
  });

  it('⚠ renders NOTHING but an empty layer when there is nothing in flight', () => {
    render(<ReactionFloaters floaters={[]} />);

    expect(screen.getByTestId('reaction-floaters').textContent).toBe('');
  });

  it('⚠⚠ carries NO sender identity — the wire payload has none and none is invented', () => {
    render(<ReactionFloaters floaters={[floater('a', '👍')]} />);

    // Only the glyph. A name here would be a claim the transport cannot support.
    expect(screen.getByTestId('reaction-floaters').textContent).toBe('👍');
  });

  it('⚠ two identical emoji coexist — double taps are expected, and the key is the NONCE', () => {
    render(<ReactionFloaters floaters={[floater('a', '👍'), floater('b', '👍')]} />);

    expect(screen.getByTestId('reaction-floaters').textContent).toBe('👍👍');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<ReactionFloaters floaters={[floater('a', '👏')]} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
