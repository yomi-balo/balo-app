import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarProviderCard } from './calendar-provider-card';

describe('CalendarProviderCard', () => {
  it('renders Google Calendar label for google provider', () => {
    render(<CalendarProviderCard provider="google" onConnect={vi.fn()} />);
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    expect(screen.getByText('Google Workspace or Gmail')).toBeInTheDocument();
  });

  it('renders Microsoft Outlook label for microsoft provider', () => {
    render(<CalendarProviderCard provider="microsoft" onConnect={vi.fn()} />);
    expect(screen.getByText('Microsoft Outlook')).toBeInTheDocument();
    expect(screen.getByText('Microsoft 365 or Outlook.com')).toBeInTheDocument();
  });

  it('renders exactly one interactive element — the Connect button, not the card itself', () => {
    render(<CalendarProviderCard provider="google" onConnect={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('calls onConnect with the provider when the Connect button is clicked', async () => {
    const onConnect = vi.fn();
    const user = userEvent.setup();
    render(<CalendarProviderCard provider="microsoft" onConnect={onConnect} />);

    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenCalledWith('microsoft');
  });
});
