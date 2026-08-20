import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarConnectionMenu } from './calendar-connection-menu';

describe('CalendarConnectionMenu', () => {
  it('carries a provider-specific aria-label on the icon-only trigger', () => {
    render(
      <CalendarConnectionMenu
        provider="google"
        slotState="connected"
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Options for Google Calendar' })).toBeInTheDocument();
  });

  // BAL-397 fix round (UX WARNING) — on mobile this trigger is the ONLY route to Reconnect or
  // Disconnect for a provider, so it must clear Balo's 44×44 touch-target floor. It shipped at
  // 36×36 inside a row that carried no compensating min-height.
  it('meets the 44px touch-target floor', () => {
    render(
      <CalendarConnectionMenu
        provider="google"
        slotState="connected"
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Options for Google Calendar' })).toHaveClass(
      'size-11'
    );
  });

  it('shows Reconnect for a connected slot', async () => {
    const user = userEvent.setup();
    render(
      <CalendarConnectionMenu
        provider="google"
        slotState="connected"
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Options for Google Calendar' }));
    expect(await screen.findByRole('menuitem', { name: /Reconnect/ })).toBeInTheDocument();
  });

  it('shows Reconnect for a reconnect_needed slot', async () => {
    const user = userEvent.setup();
    render(
      <CalendarConnectionMenu
        provider="google"
        slotState="reconnect_needed"
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Options for Google Calendar' }));
    expect(await screen.findByRole('menuitem', { name: /Reconnect/ })).toBeInTheDocument();
  });

  it('always offers Disconnect', async () => {
    const user = userEvent.setup();
    render(
      <CalendarConnectionMenu
        provider="google"
        slotState="setting_up"
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Options for Google Calendar' }));
    expect(await screen.findByRole('menuitem', { name: /Disconnect/ })).toBeInTheDocument();
  });

  it('calls onReconnect when the Reconnect item is selected', async () => {
    const onReconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarConnectionMenu
        provider="google"
        slotState="connected"
        onReconnect={onReconnect}
        onDisconnect={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Options for Google Calendar' }));
    await user.click(await screen.findByRole('menuitem', { name: /Reconnect/ }));
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('opens the disconnect confirm dialog (not an immediate disconnect) when Disconnect is selected', async () => {
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarConnectionMenu
        provider="google"
        slotState="connected"
        onReconnect={vi.fn()}
        onDisconnect={onDisconnect}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Options for Google Calendar' }));
    await user.click(await screen.findByRole('menuitem', { name: /Disconnect/ }));
    expect(await screen.findByText('Disconnect Google Calendar?')).toBeInTheDocument();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('calls onDisconnect only after the confirm dialog Disconnect action', async () => {
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarConnectionMenu
        provider="google"
        slotState="connected"
        onReconnect={vi.fn()}
        onDisconnect={onDisconnect}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Options for Google Calendar' }));
    await user.click(await screen.findByRole('menuitem', { name: /Disconnect/ }));
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledOnce();
  });
});
