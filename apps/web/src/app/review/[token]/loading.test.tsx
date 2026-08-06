import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';

import ReviewLandingLoading from './loading';

describe('ReviewLandingLoading', () => {
  /**
   * The skeleton bars are decorative. Without a live-region substitute a screen-reader
   * user gets a SILENT EMPTY PAGE for the whole resolve — and this route is a cold,
   * uncached, `force-dynamic` token lookup, so that pause is real.
   *
   * `<output>` (implicit polite live region), never `role="status"` — SonarCloud S6819.
   */
  it('announces itself instead of rendering a silent empty page', () => {
    render(<ReviewLandingLoading />);

    const region = screen.getByRole('status');
    expect(region.tagName).toBe('OUTPUT');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveTextContent('Loading your review');
  });

  it('does not hide the announcement behind aria-hidden', () => {
    const { container } = render(<ReviewLandingLoading />);

    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<ReviewLandingLoading />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
