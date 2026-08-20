import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarConnectAnother } from './calendar-connect-another';

describe('CalendarConnectAnother', () => {
  it('renders "Connect {label}" for the given provider', () => {
    render(<CalendarConnectAnother provider="microsoft" onConnect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Connect Microsoft Outlook/ })).toBeInTheDocument();
  });

  it('calls onConnect with the provider when clicked', async () => {
    const onConnect = vi.fn();
    const user = userEvent.setup();
    render(<CalendarConnectAnother provider="google" onConnect={onConnect} />);
    await user.click(screen.getByRole('button', { name: /Connect Google Calendar/ }));
    expect(onConnect).toHaveBeenCalledWith('google');
  });
});
