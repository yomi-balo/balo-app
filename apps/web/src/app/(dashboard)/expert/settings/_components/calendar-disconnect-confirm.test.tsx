import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarDisconnectConfirm } from './calendar-disconnect-confirm';

describe('CalendarDisconnectConfirm', () => {
  it('renders the warning message', () => {
    render(<CalendarDisconnectConfirm onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText(/Disconnecting will stop syncing/)).toBeInTheDocument();
  });

  it('renders Cancel and confirm buttons', () => {
    render(<CalendarDisconnectConfirm onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Yes, disconnect')).toBeInTheDocument();
  });

  it('calls onCancel when Cancel button is clicked', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<CalendarDisconnectConfirm onCancel={onCancel} onConfirm={vi.fn()} />);

    await user.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onConfirm when "Yes, disconnect" button is clicked', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<CalendarDisconnectConfirm onCancel={vi.fn()} onConfirm={onConfirm} />);

    await user.click(screen.getByText('Yes, disconnect'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
