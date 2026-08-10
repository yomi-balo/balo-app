import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';

import JoinLandingLoading from './loading';

describe('JoinLandingLoading', () => {
  /**
   * The skeleton bars are decorative. Without a live-region substitute a screen-reader
   * user gets a SILENT EMPTY PAGE for the whole resolve — and this route is a cold,
   * uncached, `force-dynamic` token lookup that fans out to the context, roster and
   * party reads, so that pause is real.
   *
   * `<output>` (implicit polite live region), never `role="status"` — SonarCloud S6819.
   */
  it('announces itself instead of rendering a silent empty page', () => {
    render(<JoinLandingLoading />);

    const region = screen.getByRole('status');
    expect(region.tagName).toBe('OUTPUT');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveTextContent('Loading your invitation');
  });

  it('does not hide the announcement behind aria-hidden', () => {
    const { container } = render(<JoinLandingLoading />);

    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  /**
   * ⚠ The skeleton is rendered BEFORE any token has resolved, so it can name nothing.
   * A placeholder that leaked "Consultation" or a company name would be a pre-auth
   * disclosure on a page that has not yet decided the token is even real.
   */
  it('names nothing that a token would have resolved to', () => {
    const { container } = render(<JoinLandingLoading />);

    expect(container.textContent).toBe('Loading your invitation…');
  });

  it('has no axe violations', async () => {
    const { container } = render(<JoinLandingLoading />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
