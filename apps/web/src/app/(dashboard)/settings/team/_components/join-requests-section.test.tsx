import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { PendingJoinRequestRow, ResolvedJoinRequestRow } from '@balo/db';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../_actions/approve-join-request', () => ({ approveJoinRequest: vi.fn() }));
vi.mock('../_actions/decline-join-request', () => ({ declineJoinRequest: vi.fn() }));

import { JoinRequestsSection } from './join-requests-section';
import { approveJoinRequest } from '../_actions/approve-join-request';
import { declineJoinRequest } from '../_actions/decline-join-request';
import { toast } from 'sonner';

const approveMock = vi.mocked(approveJoinRequest);
const declineMock = vi.mocked(declineJoinRequest);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

const PENDING: PendingJoinRequestRow[] = [
  {
    id: 'r1',
    createdAt: new Date('2020-07-07T00:00:00Z'),
    requester: { id: 'u1', firstName: 'Priya', lastName: 'Anand', email: 'priya@northwind.com' },
  },
  {
    id: 'r2',
    createdAt: new Date('2020-07-08T00:00:00Z'),
    requester: { id: 'u2', firstName: 'Marco', lastName: 'Reyes', email: 'marco@northwind.io' },
  },
];

const RESOLVED: ResolvedJoinRequestRow[] = [
  {
    id: 'h1',
    status: 'approved',
    resolvedAt: new Date('2020-07-02T00:00:00Z'),
    requester: { firstName: 'Chris', lastName: 'Vale', email: 'chris@northwind.com' },
    resolver: { firstName: 'Jordan', lastName: 'Ellis' },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JoinRequestsSection', () => {
  it('shows the caught-up empty state when there are no pending requests', () => {
    render(<JoinRequestsSection mode="request" pending={[]} resolved={[]} />);
    expect(screen.getByText(/you're all caught up/i)).toBeInTheDocument();
  });

  it('optimistically removes a row on approve and toasts success', async () => {
    approveMock.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<JoinRequestsSection mode="request" pending={PENDING} resolved={[]} />);

    expect(screen.getByText('priya@northwind.com')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /approve/i })[0] as HTMLElement);

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith({ requestId: 'r1' }));
    expect(screen.queryByText('priya@northwind.com')).not.toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith('Request approved');
  });

  it('rolls the row back with an inline error + toast.error on failure', async () => {
    approveMock.mockResolvedValue({ success: false, error: 'Nothing changed; try again.' });
    const user = userEvent.setup();
    render(<JoinRequestsSection mode="request" pending={PENDING} resolved={[]} />);

    await user.click(screen.getAllByRole('button', { name: /approve/i })[0] as HTMLElement);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Nothing changed; try again.'));
    // The row is restored, with the inline "still waiting" banner.
    expect(screen.getByText('priya@northwind.com')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/priya is still waiting/i);
  });

  it('declines a row via the decline action', async () => {
    declineMock.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<JoinRequestsSection mode="request" pending={PENDING} resolved={[]} />);

    await user.click(screen.getAllByRole('button', { name: /decline/i })[0] as HTMLElement);

    await waitFor(() => expect(declineMock).toHaveBeenCalledWith({ requestId: 'r1' }));
    expect(toastSuccess).toHaveBeenCalledWith('Request declined');
  });

  it('rolls a failed DECLINE back with the neutral (verb-agnostic) inline copy', async () => {
    declineMock.mockResolvedValue({ success: false, error: 'Nothing changed; try again.' });
    const user = userEvent.setup();
    render(<JoinRequestsSection mode="request" pending={PENDING} resolved={[]} />);

    await user.click(screen.getAllByRole('button', { name: /decline/i })[0] as HTMLElement);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Nothing changed; try again.'));
    // The row is restored; the banner uses the neutral verb (NOT "Couldn't approve"),
    // since the same row handles both approve and decline.
    expect(screen.getByText('priya@northwind.com')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/couldn't update — priya is still waiting/i);
    expect(alert).not.toHaveTextContent(/couldn't approve/i);
  });

  it('shows the mode InfoNote when the mode is not "request" but requests are waiting', () => {
    render(<JoinRequestsSection mode="auto" pending={PENDING} resolved={[]} />);
    expect(screen.getByText(/join mode is set to/i)).toBeInTheDocument();
    expect(screen.getByText('Automatic')).toBeInTheDocument();
  });

  it('toggles the resolved history disclosure', async () => {
    const user = userEvent.setup();
    render(<JoinRequestsSection mode="request" pending={[]} resolved={RESOLVED} />);

    const toggle = screen.getByRole('button', { name: /resolved \(1\)/i });
    // The panel is always rendered (so `aria-controls` never dangles) and toggled via
    // the `hidden` attribute — so it is in the DOM but not visible while collapsed.
    expect(screen.getByText(/approved by jordan ellis/i)).not.toBeVisible();
    await user.click(toggle);
    expect(screen.getByText(/approved by jordan ellis/i)).toBeVisible();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <JoinRequestsSection mode="request" pending={PENDING} resolved={RESOLVED} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
