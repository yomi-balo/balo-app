import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MembersAccessError from './error';

describe('Members & access error boundary', () => {
  it('renders the section error and fires reset on Try again', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<MembersAccessError error={new Error('boom')} reset={reset} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load members & access/i);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
