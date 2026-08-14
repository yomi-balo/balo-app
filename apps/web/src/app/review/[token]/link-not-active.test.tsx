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
   * ⚠ THE REGRESSION THIS FILE EXISTS FOR. BAL-390 shipped the signed-in rating surface as
   * an UNMOUNTED SEAM (D3), and this card's copy was written against that.
   *
   * ⚠ THAT PREMISE IS NOW STALE, BUT THE ASSERTION IS NOT — do not "restore" the
   * rate-from-here wording on the strength of the mounting alone. BAL-389 DID mount
   * `submitEngagementReviewAction` (from the end-of-call rating block), so a rating control
   * behind `/login` does exist. This card, however, is the terminal state for every expired,
   * revoked, rate-limited and DEPARTED-REVIEWER arrival: a departed reviewer fails the
   * capability gate on every path, and the others have no way to know which case they are
   * in. Telling THIS audience to sign in and rate still promises something most of them
   * cannot do. Changing the copy needs a decision about that audience, not just a mounted
   * action.
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
