import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';

import { LinkNotActive } from './link-not-active';

/**
 * The card's copy, block by block, joined with a separator.
 *
 * ⚠ NOT `container.textContent`: that concatenates adjacent blocks with no delimiter, so
 * the shipped "…rate from the case" + "Powered by…" runs together as "casePowered" and a
 * `\bcase\b` assertion silently passes against the very copy it is meant to catch.
 */
function copyBlocks(container: HTMLElement): string {
  return Array.from(container.querySelectorAll('h1, p, a'))
    .map((node) => node.textContent ?? '')
    .join(' | ');
}

describe('LinkNotActive', () => {
  it('offers exactly one recovery route, and it goes to sign-in', () => {
    render(<LinkNotActive />);

    expect(screen.getByRole('heading', { name: "This link isn't active" })).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/login');
    expect(links[0]).toHaveTextContent('Sign in to open the engagement');
  });

  /**
   * ⚠ THE REGRESSION THIS FILE EXISTS FOR. BAL-390 ships the signed-in rating surface as
   * an UNMOUNTED SEAM (D3): `submitEngagementReviewAction`, `readEngagementReview` and
   * `RatingInput` have no consumer outside the magic-link landing, so there is no rating
   * control behind `/login` at all. This card is the terminal state for every expired,
   * revoked, rate-limited and departed-reviewer arrival — the audience with no other way
   * in — so promising them a control that does not exist is the one thing it must not do.
   * Restore the rate-from-here wording when BAL-389 mounts it.
   */
  it('does NOT promise a rating control that is not mounted anywhere', () => {
    const { container } = render(<LinkNotActive />);
    const text = copyBlocks(container);

    expect(text).toMatch(/sign in and open the engagement/i);
    expect(text).not.toMatch(/\brate\b/i);
    expect(text).not.toMatch(/\brating\b/i);
  });

  /**
   * ⚠ AND IT NAMES NO ENGAGEMENT KIND. `listClosedBetween` returns `[]` until BAL-420/421
   * give `close()` a caller (D4/D5), so every live review link in production today is a
   * PROJECT link — "rate from the case" named the one kind that cannot yet produce one.
   * The generic noun is also what keeps the card oracle-free: `page.test.tsx` asserts it
   * renders byte-identically for six different outcomes, so it must not vary by kind.
   */
  it('names no engagement kind — not "case", not "project"', () => {
    const { container } = render(<LinkNotActive />);
    const text = copyBlocks(container);

    expect(text).not.toMatch(/\bcase\b/i);
    expect(text).not.toMatch(/\bproject\b/i);
  });

  it('has no axe violations', async () => {
    const { container } = render(<LinkNotActive />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
