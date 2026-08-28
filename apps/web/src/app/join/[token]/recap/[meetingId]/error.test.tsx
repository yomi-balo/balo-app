import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';

import GuestRecapError from './error';

/**
 * BAL-439 fix-round-1 / MUST-3 — mirrors `[token]/error.test.tsx` exactly: this boundary was
 * shipped at 0% coverage. Same claims, same shape: generic recovery copy, `reset` wired to "Try
 * again", neither `error.message` nor `error.digest` ever rendered (this segment's props carry
 * a guest token in scope), no sign-in CTA (a guest has no account), and an axe pass.
 */
describe('GuestRecapError', () => {
  it('renders the generic failure and fires reset on Try again', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<GuestRecapError error={new Error('boom')} reset={reset} />);

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledOnce();
  });

  /**
   * ⚠ THE LEAK THIS TEST EXISTS FOR. This segment's props carry a guest token in scope, and
   * the boundary is reached by an unauthenticated external visitor. A rendered `message` or
   * `digest` would be the one place an internal string reaches them — and it would also make
   * the boundary distinguishable from the "link isn't active" card to anyone probing.
   */
  it('renders neither the error message nor its digest', () => {
    const error = Object.assign(new Error('meeting_guests row 0xdeadbeef exploded'), {
      digest: 'digest-9f2c',
    });
    const { container } = render(<GuestRecapError error={error} reset={vi.fn()} />);
    const text = container.textContent ?? '';

    expect(text).not.toContain('meeting_guests');
    expect(text).not.toContain('0xdeadbeef');
    expect(text).not.toContain('digest-9f2c');
  });

  /**
   * ⚠ NO SIGN-IN CTA, for the same reason `link-not-active.tsx` has none: a guest has no
   * account. "Try again" is the only recovery that is real for this audience.
   */
  it('offers no sign-in route', () => {
    render(<GuestRecapError error={new Error('boom')} reset={vi.fn()} />);

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByText(/sign in/i)).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<GuestRecapError error={new Error('boom')} reset={vi.fn()} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
