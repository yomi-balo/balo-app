import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarConnectingState } from './calendar-connecting-state';

describe('CalendarConnectingState', () => {
  it('renders Google provider name when provider is google', () => {
    render(<CalendarConnectingState provider="google" onCancel={vi.fn()} />);
    expect(
      screen.getByText(/A Google Calendar sign-in window should have opened/)
    ).toBeInTheDocument();
  });

  it('renders Microsoft provider name when provider is microsoft', () => {
    render(<CalendarConnectingState provider="microsoft" onCancel={vi.fn()} />);
    expect(
      screen.getByText(/A Microsoft 365 sign-in window should have opened/)
    ).toBeInTheDocument();
  });

  it('shows the waiting status pill', () => {
    render(<CalendarConnectingState provider="google" onCancel={vi.fn()} />);
    expect(screen.getByText('Waiting for authorization...')).toBeInTheDocument();
  });

  it('renders Re-open window button', () => {
    render(<CalendarConnectingState provider="google" onCancel={vi.fn()} />);
    expect(screen.getByText('Re-open window')).toBeInTheDocument();
  });

  it('calls onCancel when Cancel button is clicked', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<CalendarConnectingState provider="google" onCancel={onCancel} />);

    await user.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
