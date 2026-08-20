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

  it('calls onReconnect when clicked', async () => {
    const onReconnect = vi.fn();
    const user = userEvent.setup();
    render(<CalendarReconnectNotice onReconnect={onReconnect} />);
    await user.click(screen.getByRole('button', { name: /Reconnect/ }));
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});
