import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';

import GuestRecapLoading from './loading';

/**
 * BAL-439 fix-round-1 / MUST-3 — mirrors `[token]/loading.test.tsx` exactly: this skeleton was
 * shipped at 0% coverage. Same claims, same shape: `<output>` (never `role="status"`, SonarCloud
 * S6819), `aria-busy` on the decorative wrapper only (never on the `<output>`, which would
 * silence the announcement it exists to make), and an axe pass.
 */
describe('GuestRecapLoading', () => {
  it('announces itself instead of rendering a silent empty page', () => {
    render(<GuestRecapLoading />);

    const region = screen.getByRole('status');
    expect(region.tagName).toBe('OUTPUT');
    expect(region).toHaveTextContent('Loading the recap');
  });

  it('⚠⚠ aria-busy is on the DECORATIVE wrapper(s), NEVER on the <output>', () => {
    // `aria-busy` tells assistive tech to SUPPRESS a live region's announcements — so on the
    // `<output>` it would silence the very "Loading the recap…" line this element exists to
    // announce. This skeleton draws THREE card blocks, and every one of them carries it.
    const { container } = render(<GuestRecapLoading />);

    expect(screen.getByRole('status').getAttribute('aria-busy')).toBeNull();
    expect(container.querySelectorAll('div[aria-busy="true"]')).toHaveLength(3);
  });

  it('does not hide the announcement behind aria-hidden', () => {
    const { container } = render(<GuestRecapLoading />);

    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  /**
   * ⚠ The skeleton is rendered before the gate has resolved anything, so it can name nothing —
   * a placeholder that leaked a context label or any other resolved copy would be a pre-auth
   * disclosure on a page that has not yet decided the token, meeting or lifecycle are even
   * valid.
   */
  it('names nothing that the gate would have resolved', () => {
    const { container } = render(<GuestRecapLoading />);

    expect(container.textContent).toBe('Loading the recap…');
  });

  it('has no axe violations', async () => {
    const { container } = render(<GuestRecapLoading />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
