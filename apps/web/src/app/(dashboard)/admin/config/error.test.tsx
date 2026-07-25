import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlatformConfigError from './error';

describe('Platform config error boundary', () => {
  it('renders the recoverable message and fires reset on Try again', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<PlatformConfigError error={new Error('boom')} reset={reset} />);

    expect(screen.getByRole('heading', { name: /didn.t load/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
