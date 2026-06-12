import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/utils';

// The board calls two server actions — mock both so it renders + fires in JSDOM.
const mockCompleteKickoff = vi.fn();
const mockApproveKickoff = vi.fn();

vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/complete-kickoff-task', () => ({
  completeKickoffTaskAction: (...args: unknown[]) => mockCompleteKickoff(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/approve-kickoff', () => ({
  approveKickoffAction: (...args: unknown[]) => mockApproveKickoff(...args),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { KickoffBoard } from './kickoff-board';

const mockToast = vi.mocked(toast);

const REQUEST_ID = 'req-1';
const RELATIONSHIP_ID = 'rel-accepted-1';

type BoardProps = React.ComponentProps<typeof KickoffBoard>;

function renderBoard(overrides: Partial<BoardProps> = {}): void {
  const props: BoardProps = {
    requestId: REQUEST_ID,
    acceptedRelationshipId: RELATIONSHIP_ID,
    lens: 'client',
    clientBillingConfirmed: false,
    expertTermsConfirmed: false,
    approved: false,
    expertName: 'Priya Nair',
    ...overrides,
  };
  render(<KickoffBoard {...props} />);
}

describe('KickoffBoard — structure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the three checklist rows under the blocking-kickoff card', () => {
    renderBoard();
    expect(screen.getByText("What's blocking kickoff")).toBeInTheDocument();
    expect(screen.getByText('Add billing details')).toBeInTheDocument();
    expect(screen.getByText('Confirm payment terms')).toBeInTheDocument();
    expect(screen.getByText('Raise & settle upfront invoice')).toBeInTheDocument();
  });

  it('shows 0/3 ready when nothing is confirmed', () => {
    renderBoard();
    expect(screen.getByText('0/3 ready')).toBeInTheDocument();
  });

  it('counts confirmed gates towards the {n}/3 ready tally', () => {
    renderBoard({ clientBillingConfirmed: true, expertTermsConfirmed: true });
    expect(screen.getByText('2/3 ready')).toBeInTheDocument();
  });

  it('shows 3/3 ready once approved (all gates met)', () => {
    renderBoard({ clientBillingConfirmed: true, expertTermsConfirmed: true, approved: true });
    expect(screen.getByText('3/3 ready')).toBeInTheDocument();
  });
});

describe('KickoffBoard — per-lens ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('client lens marks its own row "You" and shows a Complete button', () => {
    renderBoard({ lens: 'client' });
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Complete Add billing details/i })).toBeEnabled();
  });

  it('expert lens shows a Complete button on the confirm-terms row', () => {
    renderBoard({ lens: 'expert' });
    expect(screen.getByRole('button', { name: /Complete Confirm payment terms/i })).toBeEnabled();
  });

  it('admin lens shows an Approve button (not Complete) on the invoice row', () => {
    renderBoard({ lens: 'admin', clientBillingConfirmed: true, expertTermsConfirmed: true });
    expect(screen.getByRole('button', { name: /^Approve/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Complete/i })).not.toBeInTheDocument();
  });

  it('shows "Waiting" on rows owned by another party', () => {
    // Client lens: expert + admin rows are outstanding and not mine → Waiting ×2.
    renderBoard({ lens: 'client' });
    expect(screen.getAllByText('Waiting')).toHaveLength(2);
  });

  it('shows "Done" on a confirmed row (no action button)', () => {
    renderBoard({ lens: 'client', clientBillingConfirmed: true });
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Complete Add billing details/i })
    ).not.toBeInTheDocument();
  });
});

describe('KickoffBoard — admin gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables Approve until both participant gates are confirmed', () => {
    renderBoard({ lens: 'admin', clientBillingConfirmed: true, expertTermsConfirmed: false });
    expect(screen.getByRole('button', { name: /^Approve/i })).toBeDisabled();
  });

  it('enables Approve once client billing AND expert terms are confirmed', () => {
    renderBoard({ lens: 'admin', clientBillingConfirmed: true, expertTermsConfirmed: true });
    expect(screen.getByRole('button', { name: /^Approve/i })).toBeEnabled();
  });
});

describe('KickoffBoard — completing a participant task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls completeKickoffTaskAction with the accepted relationship id, toasts, and refreshes', async () => {
    mockCompleteKickoff.mockResolvedValue({ success: true, gate: 'client_billing' });
    renderBoard({ lens: 'client' });

    fireEvent.click(screen.getByRole('button', { name: /Complete Add billing details/i }));

    await waitFor(() => {
      expect(mockCompleteKickoff).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: RELATIONSHIP_ID,
      });
    });
    expect(mockToast.success).toHaveBeenCalledWith('Marked as done');
    expect(mockRefresh).toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('toasts the error and does not refresh when completing fails', async () => {
    mockCompleteKickoff.mockResolvedValue({
      success: false,
      error: 'This kickoff is no longer open.',
    });
    renderBoard({ lens: 'expert' });

    fireEvent.click(screen.getByRole('button', { name: /Complete Confirm payment terms/i }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('This kickoff is no longer open.')
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('KickoffBoard — admin approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls approveKickoffAction, fires BOTH analytics events, toasts, and refreshes', async () => {
    mockApproveKickoff.mockResolvedValue({ success: true, engagementId: 'eng-1' });
    renderBoard({ lens: 'admin', clientBillingConfirmed: true, expertTermsConfirmed: true });

    fireEvent.click(screen.getByRole('button', { name: /^Approve/i }));

    await waitFor(() => {
      expect(mockApproveKickoff).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: RELATIONSHIP_ID,
      });
    });
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_KICKOFF_APPROVED, {
      request_id: REQUEST_ID,
      actor: 'admin',
    });
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
      request_id: REQUEST_ID,
      from: 'accepted',
      to: 'kickoff_approved',
      actor: 'admin',
    });
    expect(mockToast.success).toHaveBeenCalledWith('Kickoff approved — engagement created');
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('toasts the error and fires no analytics when approval fails', async () => {
    mockApproveKickoff.mockResolvedValue({
      success: false,
      error: 'Client and expert must complete their steps first.',
    });
    renderBoard({ lens: 'admin', clientBillingConfirmed: true, expertTermsConfirmed: true });

    fireEvent.click(screen.getByRole('button', { name: /^Approve/i }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Client and expert must complete their steps first.'
      )
    );
    expect(track).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('KickoffBoard — terminal (approved) state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the celebratory kicked-off banner with all rows Done and no action buttons', () => {
    renderBoard({
      lens: 'admin',
      clientBillingConfirmed: true,
      expertTermsConfirmed: true,
      approved: true,
    });
    expect(screen.getByText('Project kicked off 🎉')).toBeInTheDocument();
    expect(screen.getByText(/left the request pipeline and entered delivery/i)).toBeInTheDocument();
    expect(screen.getAllByText('Done')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Approve|Complete/i })).not.toBeInTheDocument();
  });
});
