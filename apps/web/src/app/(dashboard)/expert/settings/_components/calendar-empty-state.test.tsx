import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarEmptyState } from './calendar-empty-state';

describe('CalendarEmptyState', () => {
  it('renders the section label', () => {
    render(<CalendarEmptyState onConnect={vi.fn()} />);
    expect(screen.getByText('Connect a calendar')).toBeInTheDocument();
  });

  it('renders the description text', () => {
    render(<CalendarEmptyState onConnect={vi.fn()} />);
    expect(
      screen.getByText(/Balo reads your calendar events to calculate your real availability/)
    ).toBeInTheDocument();
  });

  it('renders both provider buttons', () => {
    render(<CalendarEmptyState onConnect={vi.fn()} />);
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
  });

  it('calls onConnect with "google" when Google button is clicked', async () => {
    const onConnect = vi.fn();
    const user = userEvent.setup();
    render(<CalendarEmptyState onConnect={onConnect} />);

    await user.click(screen.getByText('Google Calendar'));
    expect(onConnect).toHaveBeenCalledWith('google');
  });

  it('calls onConnect with "microsoft" when Microsoft button is clicked', async () => {
    const onConnect = vi.fn();
    const user = userEvent.setup();
    render(<CalendarEmptyState onConnect={onConnect} />);

    await user.click(screen.getByText('Microsoft 365'));
    expect(onConnect).toHaveBeenCalledWith('microsoft');
  });
});
