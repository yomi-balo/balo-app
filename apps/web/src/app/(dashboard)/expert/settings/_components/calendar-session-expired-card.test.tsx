import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarSessionExpiredCard } from './calendar-session-expired-card';

describe('CalendarSessionExpiredCard', () => {
  it('renders the timed-out status pill', () => {
    render(<CalendarSessionExpiredCard provider="google" onTryAgain={vi.fn()} />);
    expect(screen.getByText('Connection attempt timed out')).toBeInTheDocument();
  });

  it('renders Google-specific message', () => {
    render(<CalendarSessionExpiredCard provider="google" onTryAgain={vi.fn()} />);
    expect(screen.getByText(/Google Calendar sign-in session expired/i)).toBeInTheDocument();
  });

  it('renders Microsoft-specific message', () => {
    render(<CalendarSessionExpiredCard provider="microsoft" onTryAgain={vi.fn()} />);
    expect(screen.getByText(/Microsoft 365 sign-in session expired/i)).toBeInTheDocument();
  });

  it('renders the reassurance message', () => {
    render(<CalendarSessionExpiredCard provider="google" onTryAgain={vi.fn()} />);
    expect(screen.getByText('No changes were made to your account.')).toBeInTheDocument();
  });

  it('renders the "Try again" button', () => {
    render(<CalendarSessionExpiredCard provider="google" onTryAgain={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('calls onTryAgain when button is clicked', async () => {
    const user = userEvent.setup();
    const mockTryAgain = vi.fn();
    render(<CalendarSessionExpiredCard provider="google" onTryAgain={mockTryAgain} />);

    await user.click(screen.getByRole('button', { name: /Try again/i }));
    expect(mockTryAgain).toHaveBeenCalledOnce();
  });
});
