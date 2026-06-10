import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';

vi.mock('server-only', () => ({}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

// The dialog only type-imports the action module; mock it so JSDOM never pulls
// the server-only graph in.
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-proposal', () => ({
  requestProposalAction: vi.fn(),
}));

import { ProposalRequestDialog } from './proposal-request-dialog';
import type { RequestProposalResult } from '@/app/(dashboard)/projects/[requestId]/_actions/request-proposal';

const mockToast = vi.mocked(toast);

const SUCCESS: RequestProposalResult = {
  success: true,
  transitioned: true,
  expertProfileId: 'exp-1',
  analytics: {
    proposalRequestCount: 1,
    timeFromFirstEoiMs: 1000,
    messageCount: 3,
    fileCount: 1,
  },
};

type RequestProposalSuccess = Extract<RequestProposalResult, { success: true }>;

function renderDialog(overrides: {
  onConfirm?: () => Promise<RequestProposalResult>;
  onConfirmed?: (result: RequestProposalSuccess) => void;
  onOpenChange?: (open: boolean) => void;
}): {
  onConfirm: ReturnType<typeof vi.fn<() => Promise<RequestProposalResult>>>;
  onConfirmed: ReturnType<typeof vi.fn<(result: RequestProposalSuccess) => void>>;
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
} {
  const confirmImpl: () => Promise<RequestProposalResult> =
    overrides.onConfirm ?? ((): Promise<RequestProposalResult> => Promise.resolve(SUCCESS));
  const confirmedImpl: (result: RequestProposalSuccess) => void =
    overrides.onConfirmed ?? ((): void => undefined);
  const openChangeImpl: (open: boolean) => void = overrides.onOpenChange ?? ((): void => undefined);
  const onConfirm = vi.fn(confirmImpl);
  const onConfirmed = vi.fn(confirmedImpl);
  const onOpenChange = vi.fn(openChangeImpl);
  render(
    <ProposalRequestDialog
      open
      onOpenChange={onOpenChange}
      expertFirstName="Priya"
      onConfirm={onConfirm}
      onConfirmed={onConfirmed}
    />
  );
  return { onConfirm, onConfirmed, onOpenChange };
}

describe('ProposalRequestDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('frames the commit with the expert name and the consequence copy', () => {
    renderDialog({});
    expect(screen.getByText('Request a proposal from Priya?')).toBeInTheDocument();
    expect(screen.getByText(/scope, deliverables, and\s+price/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not yet' })).toBeInTheDocument();
  });

  it('confirm runs the action, then onConfirmed + close — in that order', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const { onConfirm } = renderDialog({
      onConfirmed: () => {
        calls.push('confirmed');
      },
      onOpenChange: (next: boolean) => {
        calls.push(`open:${next}`);
      },
    });

    await user.click(screen.getByRole('button', { name: 'Request proposal' }));

    await waitFor(() => expect(calls).toEqual(['confirmed', 'open:false']));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('disables both buttons and shows the spinner while pending', async () => {
    const user = userEvent.setup();
    let resolve: (result: RequestProposalResult) => void = () => {};
    renderDialog({
      onConfirm: () =>
        new Promise<RequestProposalResult>((res) => {
          resolve = res;
        }),
    });

    await user.click(screen.getByRole('button', { name: 'Request proposal' }));
    expect(screen.getByRole('button', { name: 'Request proposal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Not yet' })).toBeDisabled();

    resolve(SUCCESS);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Request proposal' })).not.toBeDisabled()
    );
  });

  it('generic failure: toasts the error and STAYS OPEN for a retry', async () => {
    const user = userEvent.setup();
    const { onConfirmed, onOpenChange } = renderDialog({
      onConfirm: () =>
        Promise.resolve({ success: false as const, error: 'Could not request the proposal.' }),
    });

    await user.click(screen.getByRole('button', { name: 'Request proposal' }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('Could not request the proposal.')
    );
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('already_requested: closes quietly (the stage reconciles), no error toast', async () => {
    const user = userEvent.setup();
    const { onConfirmed, onOpenChange } = renderDialog({
      onConfirm: () =>
        Promise.resolve({
          success: false as const,
          error: "You've already requested a proposal from this expert.",
          code: 'already_requested' as const,
        }),
    });

    await user.click(screen.getByRole('button', { name: 'Request proposal' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('maps a rejected action promise to the generic copy and stays open', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({
      onConfirm: () => Promise.reject(new Error('network')),
    });

    await user.click(screen.getByRole('button', { name: 'Request proposal' }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Could not request the proposal. Please try again.'
      )
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('cancel closes via onOpenChange', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({});
    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
