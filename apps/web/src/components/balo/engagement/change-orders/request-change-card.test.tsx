import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor } from '@/test/utils';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/request-change-order', () => ({
  requestChangeOrderAction: vi.fn(),
}));

import { toast } from 'sonner';
import { requestChangeOrderAction } from '@/app/(dashboard)/engagements/[id]/_actions/request-change-order';
import { RequestChangeCard } from './request-change-card';

const requestMock = vi.mocked(requestChangeOrderAction);

function renderCard(canRequest = true): void {
  render(
    <RequestChangeCard engagementId="eng-1" canRequest={canRequest} expertParty="CloudPeak" />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requestMock.mockResolvedValue({ success: true });
});

describe('RequestChangeCard', () => {
  it('invites a request while nothing is open', () => {
    renderCard();
    expect(screen.getByText('Need something different from the plan?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request a change/ })).toBeInTheDocument();
  });

  it('explains why it cannot start another while a change is open', () => {
    renderCard(false);
    expect(
      screen.getByText("You have a change in progress. You can request another once it's decided.")
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('requires a note, then sends it trimmed and toasts the expert party', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: /Request a change/ }));
    const send = screen.getByRole('button', { name: 'Send request' });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('What would you like to change?'), '   ');
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('What would you like to change?'), ' Add a tab ');
    await user.click(send);

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith({ engagementId: 'eng-1', note: 'Add a tab' })
    );
    expect(toast.success).toHaveBeenCalledWith('Request sent to CloudPeak.');
    expect(refresh).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText('Need something different from the plan?')).toBeInTheDocument()
    );
  });

  it('keeps the note and toasts the error when the request fails', async () => {
    const user = userEvent.setup();
    requestMock.mockResolvedValue({ success: false, error: 'There is already a change open.' });
    renderCard();
    await user.click(screen.getByRole('button', { name: /Request a change/ }));
    await user.type(screen.getByLabelText('What would you like to change?'), 'Add a tab');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('There is already a change open.')
    );
    expect(screen.getByLabelText('What would you like to change?')).toHaveValue('Add a tab');
  });

  it('cancels back to the collapsed card', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: /Request a change/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: /Request a change/ })).toBeInTheDocument();
    expect(requestMock).not.toHaveBeenCalled();
  });
});
