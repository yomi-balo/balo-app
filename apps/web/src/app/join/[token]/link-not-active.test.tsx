import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';

import { LinkNotActive } from './link-not-active';

/**
 * The card's copy, block by block, joined with a separator.
 *
 * ⚠ NOT `container.textContent`: that concatenates adjacent blocks with no delimiter, so
 * a word that ends one block and a word that starts the next run together and a `\bword\b`
 * assertion silently passes against the very copy it is meant to catch. (The `/review`
 * card's own test learned this the hard way — "…the case" + "Powered by…" reads as
 * "casePowered".)
 */
function copyBlocks(container: HTMLElement): string {
  return Array.from(container.querySelectorAll('h1, p, a'))
    .map((node) => node.textContent ?? '')
    .join(' | ');
}

describe('LinkNotActive (join)', () => {
  it('renders one generic heading and no controls', () => {
    render(<LinkNotActive />);

    expect(screen.getByRole('heading', { name: "This link isn't active" })).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  /**
   * ⚠ THE REGRESSION THIS FILE EXISTS FOR, and the one place this card must NOT copy
   * `/review`'s. A reviewer is a Balo user, so `/review`'s card can honestly offer
   * "sign in". A GUEST HAS NO ACCOUNT — being invited by email is the entire premise —
   * so a sign-in CTA here is a dead end that reads as "you need an account to attend".
   * The recovery is human: ask whoever invited you.
   */
  it('offers no sign-in route, because a guest has no account to sign in to', () => {
    const { container } = render(<LinkNotActive />);
    const text = copyBlocks(container);

    expect(text).not.toMatch(/sign in/i);
    expect(text).not.toMatch(/sign up/i);
    expect(text).not.toMatch(/log in/i);
    expect(text).toMatch(/invited you/i);
  });

  /**
   * ⚠ IT NAMES NOTHING. This card renders for a token that never existed, so it cannot
   * reference anything a token might have resolved to — and it must be byte-identical
   * across seven different outcomes (`page.test.tsx`), so it cannot vary at all. The
   * strongest form of that guarantee is structural: the component takes NO PROPS.
   */
  it('discloses no meeting state — not cancelled, not expired, not removed', () => {
    const { container } = render(<LinkNotActive />);
    const text = copyBlocks(container);

    expect(text).not.toMatch(/\bcancelled\b/i);
    expect(text).not.toMatch(/\bexpired\b/i);
    expect(text).not.toMatch(/\bremoved\b/i);
    expect(text).not.toMatch(/\brevoked\b/i);
    expect(text).not.toMatch(/\bmeeting\b/i);
    expect(text).not.toMatch(/\bcall\b/i);
  });

  it('takes no props, so it cannot be made to vary by outcome', () => {
    expect(LinkNotActive).toHaveLength(0);
  });

  it('has no axe violations', async () => {
    const { container } = render(<LinkNotActive />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
