import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarDisconnectConfirm } from './calendar-disconnect-confirm';

describe('CalendarDisconnectConfirm', () => {
  it('renders a provider-specific title, not the retired "all calendars" copy', () => {
    render(
      <CalendarDisconnectConfirm
        provider="google"
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    expect(screen.getByText('Disconnect Google Calendar?')).toBeInTheDocument();
    expect(screen.queryByText(/all calendars/i)).not.toBeInTheDocument();
  });

  it('renders the Microsoft label for the microsoft provider', () => {
    render(
      <CalendarDisconnectConfirm
        provider="microsoft"
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    expect(screen.getByText('Disconnect Microsoft Outlook?')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(
      <CalendarDisconnectConfirm
        provider="google"
        open={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    expect(screen.queryByText('Disconnect Google Calendar?')).not.toBeInTheDocument();
  });

  it('calls onConfirm when the Disconnect action is clicked', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarDisconnectConfirm
        provider="google"
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onOpenChange(false) when Keep it connected is clicked', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarDisconnectConfirm
        provider="google"
        open
        onOpenChange={onOpenChange}
        onConfirm={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Keep it connected' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
