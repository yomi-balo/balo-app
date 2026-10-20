import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import type { PassableRelationshipStatus } from '@balo/shared/project-requests';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const mockPush = vi.hoisted(() => vi.fn());
const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

const mockPassOnRequest = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/pass-on-request', () => ({
  passOnRequestAction: (...args: unknown[]) => mockPassOnRequest(...args),
}));

import { PassOnRequestControl } from './pass-on-request-control';

function renderControl(relationshipStatus: PassableRelationshipStatus = 'eoi_submitted'): void {
  render(
    <PassOnRequestControl
      requestId={REQUEST_ID}
      requestTitle="CPQ implementation"
      relationshipStatus={relationshipStatus}
    />
  );
}

async function openDialog(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Pass on this project' }));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPassOnRequest.mockResolvedValue({ success: true });
});

describe('PassOnRequestControl', () => {
  it('renders only the quiet trigger until it is opened', () => {
    renderControl();
    expect(screen.getByRole('button', { name: 'Pass on this project' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('opens the confirm dialog with the verbatim copy and "Keep it" focused', async () => {
    renderControl();
    await openDialog();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Pass on this project?');
    expect(dialog).toHaveTextContent(
      "Balo will look for other experts. You won't be able to rejoin this request yourself."
    );
    expect(screen.getByRole('button', { name: 'Pass' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus());
  });

  it.each(['invited', 'eoi_submitted'] as const)(
    'at %s the body carries no draft-withdrawal sentence',
    async (status) => {
      renderControl(status);
      await openDialog();
      expect(await screen.findByRole('alertdialog')).not.toHaveTextContent(/draft proposal/);
    }
  );

  it('at proposal_requested the body adds the draft-withdrawal sentence after the ticket copy', async () => {
    renderControl('proposal_requested');
    await openDialog();
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      "Balo will look for other experts. You won't be able to rejoin this request yourself. Any draft proposal you've started will be withdrawn."
    );
  });

  it('"Keep it" dismisses without calling the action', async () => {
    renderControl();
    const user = await openDialog();
    await user.click(await screen.findByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockPassOnRequest).not.toHaveBeenCalled();
  });

  it('"Pass" calls the action with the request id and the control surface, toasts and redirects to /projects', async () => {
    renderControl();
    const user = await openDialog();
    await user.click(await screen.findByRole('button', { name: 'Pass' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/projects'));
    expect(mockPassOnRequest).toHaveBeenCalledWith({ requestId: REQUEST_ID, surface: 'control' });
    expect(toast.success).toHaveBeenCalledWith("You've passed on CPQ implementation");
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('shows "Passing…" with both buttons disabled while the action runs', async () => {
    let finish: (value: { success: true }) => void = () => undefined;
    mockPassOnRequest.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    renderControl();
    const user = await openDialog();
    await user.click(await screen.findByRole('button', { name: 'Pass' }));

    const passing = await screen.findByRole('button', { name: 'Passing…' });
    expect(passing).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeDisabled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    finish({ success: true });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/projects'));
  });

  it('a failure toasts the error, closes the dialog and does not redirect', async () => {
    mockPassOnRequest.mockResolvedValue({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
    renderControl();
    const user = await openDialog();
    await user.click(await screen.findByRole('button', { name: 'Pass' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('You do not have permission to do this.')
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('a not_passable failure also refreshes the page', async () => {
    mockPassOnRequest.mockResolvedValue({
      success: false,
      error: 'This project can no longer be passed on.',
      code: 'not_passable',
    });
    renderControl();
    const user = await openDialog();
    await user.click(await screen.findByRole('button', { name: 'Pass' }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith('This project can no longer be passed on.');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('a thrown action toasts a generic error and reports to Sentry', async () => {
    const boom = new Error('network down');
    mockPassOnRequest.mockRejectedValue(boom);
    renderControl();
    const user = await openDialog();
    await user.click(await screen.findByRole('button', { name: 'Pass' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Something went wrong. Please try again.')
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(boom);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockPush).not.toHaveBeenCalled();
  });
});
