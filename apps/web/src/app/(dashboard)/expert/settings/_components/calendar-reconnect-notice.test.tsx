import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarReconnectNotice } from './calendar-reconnect-notice';

describe('CalendarReconnectNotice', () => {
  it('explains the loss without blaming the expert and offers Reconnect', () => {
    render(<CalendarReconnectNotice onReconnect={vi.fn()} />);
    expect(screen.getByText(/lost access to this calendar/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reconnect/ })).toBeInTheDocument();
  });

  // BAL-576 — the notice used to claim availability "still shows" while broken, which is false:
  // the busy check fails closed, so a broken connection pauses bookings, not just sync.
  it('states that bookings are paused, never that availability still shows', () => {
    render(<CalendarReconnectNotice onReconnect={vi.fn()} />);
    expect(
      screen.getByText(/bookings with you are paused until you reconnect/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/availability still shows/)).not.toBeInTheDocument();
  });

  it('calls onReconnect when clicked', async () => {
    const onReconnect = vi.fn();
    const user = userEvent.setup();
    render(<CalendarReconnectNotice onReconnect={onReconnect} />);
    await user.click(screen.getByRole('button', { name: /Reconnect/ }));
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});
