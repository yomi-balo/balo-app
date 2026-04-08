import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarO365GuidanceModal } from './calendar-o365-guidance-modal';

describe('CalendarO365GuidanceModal', () => {
  it('renders the header with Microsoft 365 title', () => {
    render(<CalendarO365GuidanceModal onContinue={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Connect Microsoft 365')).toBeInTheDocument();
    expect(screen.getByText('Outlook or Microsoft 365 work account')).toBeInTheDocument();
  });

  it('renders the admin approval callout', () => {
    render(<CalendarO365GuidanceModal onContinue={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Your IT admin may need to approve this once')).toBeInTheDocument();
    expect(screen.getByText(/once for your entire company/i)).toBeInTheDocument();
  });

  it('renders all four "What to expect" steps', () => {
    render(<CalendarO365GuidanceModal onContinue={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('What to expect')).toBeInTheDocument();
    expect(screen.getByText('A Microsoft sign-in window opens')).toBeInTheDocument();
    expect(screen.getByText('Sign in with your work account')).toBeInTheDocument();
    expect(screen.getByText(/If prompted for admin approval/i)).toBeInTheDocument();
    expect(screen.getByText(/Once approved, click "Connect" again/i)).toBeInTheDocument();
  });

  it('renders the external admin approval guide link', () => {
    render(<CalendarO365GuidanceModal onContinue={vi.fn()} onCancel={vi.fn()} />);
    const link = screen.getByText('Admin approval guide');
    expect(link).toHaveAttribute(
      'href',
      'https://docs.cronofy.com/calendar-admins/faqs/need-admin-approval-error/'
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('calls onContinue when "Continue to Microsoft 365" is clicked', async () => {
    const user = userEvent.setup();
    const mockContinue = vi.fn();
    render(<CalendarO365GuidanceModal onContinue={mockContinue} onCancel={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Continue to Microsoft 365/i }));
    expect(mockContinue).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const mockCancel = vi.fn();
    render(<CalendarO365GuidanceModal onContinue={vi.fn()} onCancel={mockCancel} />);

    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(mockCancel).toHaveBeenCalledOnce();
  });
});
