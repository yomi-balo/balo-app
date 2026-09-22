import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OnboardingError from './error';

vi.mock('@/lib/auth/actions/logout', () => ({ logoutAction: vi.fn() }));

describe('Onboarding error boundary', () => {
  it('renders the branded error and fires reset on Try again', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<OnboardingError error={new Error('boom')} reset={reset} />);

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    expect(screen.getByText(/couldn't load this step/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('keeps the sign-out exit reachable — the onboarding gate leaves no other way out', () => {
    render(<OnboardingError error={new Error('boom')} reset={vi.fn()} />);
    expect(screen.getByRole('button', { name: /not you\? sign out/i })).toBeEnabled();
  });
});
