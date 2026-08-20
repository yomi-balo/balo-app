import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CALENDAR_HELP_URL } from '../_lib/calendar-help';
import { CalendarO365WaitingNotice } from './calendar-o365-waiting-notice';

describe('CalendarO365WaitingNotice', () => {
  it('renders as a non-Card notice (no card border shell of its own)', () => {
    const { container } = render(
      <CalendarO365WaitingNotice onTryAgain={vi.fn()} onCancel={vi.fn()} />
    );
    expect(container.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
  });

  it('renders the waiting status pill', () => {
    render(<CalendarO365WaitingNotice onTryAgain={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Waiting for IT admin approval')).toBeInTheDocument();
  });

  it('renders the heading', () => {
    render(<CalendarO365WaitingNotice onTryAgain={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Your IT admin needs to take action')).toBeInTheDocument();
  });

  it('renders the three instruction steps', () => {
    render(<CalendarO365WaitingNotice onTryAgain={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/Ask your IT admin to approve "Balo"/i)).toBeInTheDocument();
    expect(screen.getByText(/This approval only needs to happen once/i)).toBeInTheDocument();
    expect(screen.getByText(/Once approved, click "Try connecting again"/i)).toBeInTheDocument();
  });

  it('renders the external admin approval guide link', () => {
    render(<CalendarO365WaitingNotice onTryAgain={vi.fn()} onCancel={vi.fn()} />);
    const link = screen.getByText('View admin approval guide');
    expect(link).toHaveAttribute('href', CALENDAR_HELP_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('calls onTryAgain when "Try connecting again" is clicked', async () => {
    const user = userEvent.setup();
    const mockTryAgain = vi.fn();
    render(<CalendarO365WaitingNotice onTryAgain={mockTryAgain} onCancel={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Try connecting again/i }));
    expect(mockTryAgain).toHaveBeenCalledOnce();
  });

  it('renders "Not now" (not "Cancel") and calls onCancel when clicked', async () => {
    const user = userEvent.setup();
    const mockCancel = vi.fn();
    render(<CalendarO365WaitingNotice onTryAgain={vi.fn()} onCancel={mockCancel} />);

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(mockCancel).toHaveBeenCalledOnce();
  });
});
