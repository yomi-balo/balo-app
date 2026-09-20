import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';

import GuestRecapIndexError from './error';

/**
 * BAL-492 — mirrors `[meetingId]/error.test.tsx` exactly: generic recovery copy, `reset` wired
 * to "Try again", neither `error.message` nor `error.digest` ever rendered (this segment's
 * props carry a guest token in scope), no sign-in CTA, and an axe pass.
 */
describe('GuestRecapIndexError', () => {
  it('renders the generic failure and fires reset on Try again', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<GuestRecapIndexError error={new Error('boom')} reset={reset} />);

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('renders neither the error message nor its digest', () => {
    const error = Object.assign(new Error('meeting_contexts row 0xdeadbeef exploded'), {
      digest: 'digest-9f2c',
    });
    const { container } = render(<GuestRecapIndexError error={error} reset={vi.fn()} />);
    const text = container.textContent ?? '';

    expect(text).not.toContain('meeting_contexts');
    expect(text).not.toContain('0xdeadbeef');
    expect(text).not.toContain('digest-9f2c');
  });

  it('offers no sign-in route', () => {
    render(<GuestRecapIndexError error={new Error('boom')} reset={vi.fn()} />);

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByText(/sign in/i)).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <GuestRecapIndexError error={new Error('boom')} reset={vi.fn()} />
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
