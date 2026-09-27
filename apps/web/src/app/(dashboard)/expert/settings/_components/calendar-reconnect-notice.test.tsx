import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarReconnectNotice } from './calendar-reconnect-notice';

describe('CalendarReconnectNotice', () => {
  it('explains the loss without blaming the expert and offers Reconnect', () => {
    render(<CalendarReconnectNotice onReconnect={vi.fn()} checkedForBusyTime />);
    expect(screen.getByText(/lost access to this calendar/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reconnect/ })).toBeInTheDocument();
  });

  // BAL-576 — the notice used to claim availability "still shows" while broken, which is false:
  // the busy check fails closed, so a broken connection pauses bookings, not just sync.
  //
  // BAL-576 round 2 — that pause claim is itself only true when this connection was ever
  // considered for the busy read (`checkedForBusyTime`); a provisioned connection with no
  // conflict-checked calendar contributes nothing either way, so breaking it changes nothing.
  it('checkedForBusyTime true: states bookings are paused', () => {
    render(<CalendarReconnectNotice onReconnect={vi.fn()} checkedForBusyTime />);
    expect(
      screen.getByText(
        "We've lost access to this calendar — this usually happens after a password change, or when calendar access is turned off. We can't check it for busy time, so bookings with you are paused until you reconnect."
      )
    ).toBeInTheDocument();
  });

  it('checkedForBusyTime false: syncing stops, but never claims bookings are paused', () => {
    render(<CalendarReconnectNotice onReconnect={vi.fn()} checkedForBusyTime={false} />);
    expect(
      screen.getByText(
        "We've lost access to this calendar — this usually happens after a password change, or when calendar access is turned off. It won't sync until you reconnect."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/paused/)).not.toBeInTheDocument();
  });

  it('calls onReconnect when clicked', async () => {
    const onReconnect = vi.fn();
    const user = userEvent.setup();
    render(<CalendarReconnectNotice onReconnect={onReconnect} checkedForBusyTime />);
    await user.click(screen.getByRole('button', { name: /Reconnect/ }));
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});
