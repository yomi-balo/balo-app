import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GuestRosterRow } from '@/lib/meetings/guest-roster';
import { LobbyQueueRow } from './lobby-queue-row';

function row(overrides: Partial<GuestRosterRow> = {}): GuestRosterRow {
  return {
    guest: {
      id: 'knock-1',
      name: 'Taylor Wu',
      displayName: 'Taylor Wu',
      party: 'client',
      participationRole: 'guest',
      admission: 'pending',
      inviteChannel: 'link',
    },
    state: 'waiting',
    isUnverified: true,
    canResendLink: false,
    canRemove: false,
    canVouch: false,
    ...overrides,
  };
}

function renderRow(options: { row?: GuestRosterRow; canHost?: boolean; isPending?: boolean } = {}) {
  const onDecide = vi.fn();
  const onVouch = vi.fn();
  render(
    <ul>
      <LobbyQueueRow
        row={options.row ?? row()}
        canHost={options.canHost ?? true}
        onDecide={onDecide}
        onVouch={onVouch}
        isPending={options.isPending ?? false}
      />
    </ul>
  );
  return { onDecide, onVouch };
}

describe('LobbyQueueRow', () => {
  it('renders Admit and Deny for a host, and no Vouch without the verdict', async () => {
    const user = userEvent.setup();
    const { onDecide } = renderRow();

    await user.click(screen.getByRole('button', { name: 'Admit Taylor Wu' }));
    await user.click(screen.getByRole('button', { name: 'Deny Taylor Wu' }));

    expect(onDecide).toHaveBeenNthCalledWith(1, 'knock-1', 'admit', 'Taylor Wu');
    expect(onDecide).toHaveBeenNthCalledWith(2, 'knock-1', 'deny', 'Taylor Wu');
    expect(screen.queryByRole('button', { name: /vouch/i })).not.toBeInTheDocument();
  });

  it('renders Vouch only, with no decision pair, for a vouch-capable non-host', async () => {
    const user = userEvent.setup();
    const { onVouch } = renderRow({ row: row({ canVouch: true }), canHost: false });

    expect(screen.queryByRole('button', { name: /admit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /deny/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Vouch for Taylor Wu' }));

    expect(onVouch).toHaveBeenCalledWith('knock-1', 'Taylor Wu');
  });

  it('shows the spinner instead of any control while pending', () => {
    renderRow({ row: row({ canVouch: true }), isPending: true });

    expect(screen.getByTestId('queue-row-spinner')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the Unverified badge on a vouchable row', () => {
    renderRow({ row: row({ canVouch: true }) });

    expect(screen.getByText('Unverified')).toBeInTheDocument();
  });
});
