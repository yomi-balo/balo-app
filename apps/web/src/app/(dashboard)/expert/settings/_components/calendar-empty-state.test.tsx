import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarEmptyState } from './calendar-empty-state';

describe('CalendarEmptyState', () => {
  it('renders the hero invitation, not an absence-framed message', () => {
    render(<CalendarEmptyState providers={['google', 'microsoft']} onConnect={vi.fn()} />);
    expect(screen.getByText('Connect your calendar')).toBeInTheDocument();
    expect(screen.queryByText(/no calendar/i)).not.toBeInTheDocument();
  });

  it('renders a provider card for every offerable provider', () => {
    render(<CalendarEmptyState providers={['google', 'microsoft']} onConnect={vi.fn()} />);
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    expect(screen.getByText('Microsoft Outlook')).toBeInTheDocument();
  });

  it('renders only the providers passed, in PROVIDER_ORDER', () => {
    render(<CalendarEmptyState providers={['microsoft']} onConnect={vi.fn()} />);
    expect(screen.queryByText('Google Calendar')).not.toBeInTheDocument();
    expect(screen.getByText('Microsoft Outlook')).toBeInTheDocument();
  });

  it('calls onConnect with "google" when the Google Connect button is clicked', async () => {
    const onConnect = vi.fn();
    const user = userEvent.setup();
    render(<CalendarEmptyState providers={['google', 'microsoft']} onConnect={onConnect} />);

    const [googleButton] = screen.getAllByRole('button', { name: 'Connect' });
    if (!googleButton) throw new Error('expected a Connect button');
    await user.click(googleButton);
    expect(onConnect).toHaveBeenCalledWith('google');
  });

  it('calls onConnect with "microsoft" when the Microsoft Connect button is clicked', async () => {
    const onConnect = vi.fn();
    const user = userEvent.setup();
    render(<CalendarEmptyState providers={['google', 'microsoft']} onConnect={onConnect} />);

    const buttons = screen.getAllByRole('button', { name: 'Connect' });
    const microsoftButton = buttons[1];
    if (!microsoftButton) throw new Error('expected a second Connect button');
    await user.click(microsoftButton);
    expect(onConnect).toHaveBeenCalledWith('microsoft');
  });
});
