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
import { track, PROJECT_EVENTS, BILLING_EVENTS } from '@/lib/analytics';
import type { KickoffBillingCapture } from '@/lib/billing/billing-capture';
import { KickoffBoard } from './kickoff-board';

const mockToast = vi.mocked(toast);

const REQUEST_ID = 'req-1';
const RELATIONSHIP_ID = 'rel-accepted-1';
const COMPANY_ID = 'company-1';

/** Client billing-capture context — the page passes this for the client lens. */
function billingCapture(overrides: Partial<KickoffBillingCapture> = {}): KickoffBillingCapture {
  return { companyId: COMPANY_ID, canManage: true, details: null, ...overrides };
}

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

  it('client owner/admin marks its own row "You" and shows the capture button', () => {
    renderBoard({ lens: 'client', billing: billingCapture({ canManage: true }) });
    expect(screen.getByText('You')).toBeInTheDocument();
    // BAL-323: the client row opens the billing form, not the generic gate flip.
    expect(screen.getByRole('button', { name: /Add details/i })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: /Complete Add billing details/i })
    ).not.toBeInTheDocument();
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

  it('shows "Done" + a View affordance on the confirmed billing row (owner/admin)', () => {
    renderBoard({
      lens: 'client',
      clientBillingConfirmed: true,
      billing: billingCapture({
        details: {
          legalName: 'Acme Pty Ltd',
          countryCode: 'AU',
          taxId: '51 824 753 556',
          address: null,
          billingEmail: 'ap@acme.example',
        },
      }),
    });
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View/i })).toBeInTheDocument();
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

  it('the client billing row opens the capture form (never the generic gate flip)', async () => {
    renderBoard({ lens: 'client', billing: billingCapture({ canManage: true }) });

    fireEvent.click(screen.getByRole('button', { name: /Add details/i }));

    // The BAL-323 dialog opens — a form field unique to it — and the client
    // never invokes the direct completeKickoffTaskAction gate flip.
    await waitFor(() => expect(screen.getByText('Legal / entity name')).toBeInTheDocument());
    expect(mockCompleteKickoff).not.toHaveBeenCalled();
  });

  it('fires the gate-confirmed event with the expert actor when the expert completes', async () => {
    mockCompleteKickoff.mockResolvedValue({ success: true, gate: 'expert_terms' });
    renderBoard({ lens: 'expert' });

    fireEvent.click(screen.getByRole('button', { name: /Complete Confirm payment terms/i }));

    await waitFor(() => {
      expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_KICKOFF_GATE_CONFIRMED, {
        request_id: REQUEST_ID,
        relationship_id: RELATIONSHIP_ID,
        gate: 'expert_terms',
        actor: 'expert',
      });
    });
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

describe('KickoffBoard — client billing capture (BAL-323)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a plain member sees the "what happens next" notice, not a capture button', () => {
    renderBoard({ lens: 'client', billing: billingCapture({ canManage: false }) });
    expect(
      screen.getByText(/A company owner or admin needs to add these billing details/i)
    ).toBeInTheDocument();
    expect(screen.getByText('Owner/admin only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add details/i })).not.toBeInTheDocument();
  });

  it('fires billing_details_blocked_view when a member is blocked', () => {
    renderBoard({ lens: 'client', billing: billingCapture({ canManage: false }) });
    expect(track).toHaveBeenCalledWith(BILLING_EVENTS.DETAILS_BLOCKED_VIEW, {
      company_id: COMPANY_ID,
      request_id: REQUEST_ID,
    });
  });

  it('does NOT fire the blocked event for an owner/admin who can proceed', () => {
    renderBoard({ lens: 'client', billing: billingCapture({ canManage: true }) });
    expect(track).not.toHaveBeenCalledWith(BILLING_EVENTS.DETAILS_BLOCKED_VIEW, expect.anything());
  });

  it('shows the notice but does NOT re-fire the blocked event from the mobile board', () => {
    // The mobile board lives in a lazily-mounted sheet; only the desktop board
    // counts the block, so opening the sheet must not double-fire.
    renderBoard({ lens: 'client', billing: billingCapture({ canManage: false }), mobile: true });
    expect(
      screen.getByText(/A company owner or admin needs to add these billing details/i)
    ).toBeInTheDocument();
    expect(track).not.toHaveBeenCalledWith(BILLING_EVENTS.DETAILS_BLOCKED_VIEW, expect.anything());
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
