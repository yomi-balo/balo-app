import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarO365WaitingCard } from './calendar-o365-waiting-card';

describe('CalendarO365WaitingCard', () => {
  it('renders the waiting status pill', () => {
    render(<CalendarO365WaitingCard onTryAgain={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Waiting for IT admin approval')).toBeInTheDocument();
  });

  it('renders the heading', () => {
    render(<CalendarO365WaitingCard onTryAgain={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Your IT admin needs to take action')).toBeInTheDocument();
  });

  it('renders the three instruction steps', () => {
    render(<CalendarO365WaitingCard onTryAgain={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/Ask your IT admin to approve "Balo"/i)).toBeInTheDocument();
    expect(screen.getByText(/This approval only needs to happen once/i)).toBeInTheDocument();
    expect(screen.getByText(/Once approved, click "Try connecting again"/i)).toBeInTheDocument();
  });

  it('renders the external admin approval guide link', () => {
    render(<CalendarO365WaitingCard onTryAgain={vi.fn()} onCancel={vi.fn()} />);
    const link = screen.getByText('View admin approval guide');
    expect(link).toHaveAttribute(
      'href',
      'https://docs.cronofy.com/calendar-admins/faqs/need-admin-approval-error/'
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('calls onTryAgain when "Try connecting again" is clicked', async () => {
    const user = userEvent.setup();
    const mockTryAgain = vi.fn();
    render(<CalendarO365WaitingCard onTryAgain={mockTryAgain} onCancel={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Try connecting again/i }));
    expect(mockTryAgain).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const mockCancel = vi.fn();
    render(<CalendarO365WaitingCard onTryAgain={vi.fn()} onCancel={mockCancel} />);

    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(mockCancel).toHaveBeenCalledOnce();
  });
});
