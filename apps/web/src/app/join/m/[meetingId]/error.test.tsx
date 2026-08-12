import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import LobbyError from './error';

const ERROR = Object.assign(new Error('postgres connection refused at 10.0.0.4'), {
  digest: 'abc123digest',
});

describe('LobbyError', () => {
  it('renders a neutral message and a retry control', () => {
    render(<LobbyError error={ERROR} reset={vi.fn()} />);

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('⚠⚠ NEVER renders the error message or its digest', () => {
    // This is a PUBLIC, unauthenticated surface. Showing `message` or `digest` leaks server
    // internals to anyone who can reach a meeting URL.
    const { container } = render(<LobbyError error={ERROR} reset={vi.fn()} />);
    const markup = container.innerHTML;

    expect(markup).not.toContain('postgres');
    expect(markup).not.toContain('10.0.0.4');
    expect(markup).not.toContain('abc123digest');
  });

  it('calls reset when retried', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<LobbyError error={ERROR} reset={reset} />);

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<LobbyError error={ERROR} reset={vi.fn()} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
