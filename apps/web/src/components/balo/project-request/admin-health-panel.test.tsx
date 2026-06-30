import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/utils';
import type { RequestRelationshipView } from '@/lib/project-request/request-detail-view';

const mockRemove = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/remove-invited-expert', () => ({
  removeInvitedExpertAction: (...args: unknown[]) => mockRemove(...args),
}));

const mockRequestProposalAsAdmin = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-proposal-as-admin', () => ({
  requestProposalAsAdmin: (...args: unknown[]) => mockRequestProposalAsAdmin(...args),
}));

// The invite dialog (rendered by the panel) imports these.
const mockSearchExperts = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/search-experts-for-invite', () => ({
  searchExpertsForInviteAction: (...args: unknown[]) => mockSearchExperts(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/invite-experts', () => ({
  inviteExpertsAction: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { AdminHealthPanel } from './admin-health-panel';

const mockToast = vi.mocked(toast);
const mockTrack = vi.mocked(track);

const REQUEST_ID = 'req-1';

function rel(overrides: Partial<RequestRelationshipView> = {}): RequestRelationshipView {
  return {
    id: 'rel-1',
    expertName: 'Priya Nair',
    status: 'invited',
    state: 'invited',
    isQuiet: false,
    quietDays: 0,
    removable: true,
    ...overrides,
  };
}

describe('AdminHealthPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchExperts.mockResolvedValue({ success: true, experts: [] });
  });

  it('renders the derived state label per expert', () => {
    render(
      <AdminHealthPanel
        requestId={REQUEST_ID}
        status="experts_invited"
        relationships={[rel(), rel({ id: 'rel-2', expertName: 'Sofia Ruiz', state: 'eoi_in' })]}
      />
    );
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
    expect(screen.getByText('Invited · awaiting EOI')).toBeInTheDocument();
    expect(screen.getByText('EOI in · talking')).toBeInTheDocument();
  });

  it('shows the "Quiet N days" pill only when the row is quiet', () => {
    render(
      <AdminHealthPanel
        requestId={REQUEST_ID}
        status="experts_invited"
        relationships={[
          rel({ isQuiet: true, quietDays: 4 }),
          rel({ id: 'rel-2', expertName: 'Sofia Ruiz', isQuiet: false }),
        ]}
      />
    );
    expect(screen.getByText('Quiet 4 days')).toBeInTheDocument();
    expect(screen.getAllByText(/Quiet/)).toHaveLength(1);
  });

  it('enables remove within the window for an invited row', () => {
    render(
      <AdminHealthPanel requestId={REQUEST_ID} status="experts_invited" relationships={[rel()]} />
    );
    expect(screen.getByRole('button', { name: /Remove Priya Nair/i })).toBeInTheDocument();
  });

  it('hides remove when the row is no longer removable (past invited)', () => {
    render(
      <AdminHealthPanel
        requestId={REQUEST_ID}
        status="experts_invited"
        relationships={[rel({ status: 'eoi_submitted', state: 'eoi_in', removable: false })]}
      />
    );
    expect(screen.queryByRole('button', { name: /Remove/i })).not.toBeInTheDocument();
  });

  it('hides remove + invite-another once the window has closed (proposal_requested)', () => {
    render(
      <AdminHealthPanel
        requestId={REQUEST_ID}
        status="proposal_requested"
        relationships={[rel({ status: 'invited', removable: true })]}
      />
    );
    expect(screen.queryByRole('button', { name: /Remove/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Invite another expert/i })
    ).not.toBeInTheDocument();
  });

  it('confirms then calls removeInvitedExpertAction and toasts', async () => {
    mockRemove.mockResolvedValue({ success: true });
    render(
      <AdminHealthPanel requestId={REQUEST_ID} status="experts_invited" relationships={[rel()]} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Remove Priya Nair/i }));
    // Confirmation dialog appears.
    const confirm = await screen.findByRole('button', { name: /^Remove$/i });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mockRemove).toHaveBeenCalledWith({ requestId: REQUEST_ID, relationshipId: 'rel-1' })
    );
    expect(mockToast.success).toHaveBeenCalledWith('Priya Nair removed.');
  });

  it('opens the invite dialog from "Invite another expert"', async () => {
    render(
      <AdminHealthPanel requestId={REQUEST_ID} status="experts_invited" relationships={[rel()]} />
    );
    fireEvent.click(screen.getByRole('button', { name: /Invite another expert/i }));
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /Invite experts/i })).toBeInTheDocument()
    );
  });

  describe('Request proposal control (BAL-315)', () => {
    it('renders the request-proposal control for an invited row', () => {
      render(
        <AdminHealthPanel
          requestId={REQUEST_ID}
          status="experts_invited"
          relationships={[rel({ status: 'invited' })]}
        />
      );
      expect(
        screen.getByRole('button', { name: /Request proposal from Priya Nair/i })
      ).toBeInTheDocument();
    });

    it('renders the request-proposal control for an eoi_submitted row', () => {
      render(
        <AdminHealthPanel
          requestId={REQUEST_ID}
          status="eoi_submitted"
          relationships={[rel({ status: 'eoi_submitted', state: 'eoi_in', removable: false })]}
        />
      );
      expect(
        screen.getByRole('button', { name: /Request proposal from Priya Nair/i })
      ).toBeInTheDocument();
    });

    it.each(['proposal_requested', 'proposal_submitted', 'accepted', 'declined'])(
      'hides the request-proposal control for a %s row (relationship-level gate)',
      (status) => {
        render(
          <AdminHealthPanel
            requestId={REQUEST_ID}
            status="proposal_requested"
            relationships={[rel({ status, removable: false })]}
          />
        );
        expect(screen.queryByRole('button', { name: /Request proposal/i })).not.toBeInTheDocument();
      }
    );

    it('confirms, calls the action, fires analytics (admin surface, no thread_count), and toasts', async () => {
      mockRequestProposalAsAdmin.mockResolvedValue({
        success: true,
        expertProfileId: 'expert-1',
        transitioned: true,
        requestTransition: { from: 'experts_invited', to: 'proposal_requested' },
        analytics: {
          proposalRequestCount: 1,
          timeFromFirstEoiMs: 1234,
          messageCount: 3,
          fileCount: 0,
        },
      });
      render(
        <AdminHealthPanel
          requestId={REQUEST_ID}
          status="experts_invited"
          relationships={[rel({ status: 'invited' })]}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /Request proposal from Priya Nair/i }));
      const confirm = await screen.findByRole('button', { name: /^Request proposal$/i });
      fireEvent.click(confirm);

      await waitFor(() =>
        expect(mockRequestProposalAsAdmin).toHaveBeenCalledWith({
          requestId: REQUEST_ID,
          relationshipId: 'rel-1',
        })
      );
      expect(mockToast.success).toHaveBeenCalledWith(
        'Proposal requested — Priya Nair has been notified.'
      );

      expect(mockTrack).toHaveBeenCalledWith(
        PROJECT_EVENTS.PROJECT_PROPOSAL_REQUESTED,
        expect.objectContaining({
          request_id: REQUEST_ID,
          relationship_id: 'rel-1',
          expert_id: 'expert-1',
          actor: 'admin',
          surface: 'admin',
          proposal_request_count: 1,
          time_from_first_eoi_ms: 1234,
          message_count: 3,
          file_count: 0,
        })
      );
      // The admin surface has no client thread island → no thread_count.
      const proposalCall = mockTrack.mock.calls.find(
        (c) => c[0] === PROJECT_EVENTS.PROJECT_PROPOSAL_REQUESTED
      );
      expect(proposalCall?.[1]).not.toHaveProperty('thread_count');
      // The canonical transition stream stays complete.
      expect(mockTrack).toHaveBeenCalledWith(
        PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED,
        expect.objectContaining({
          request_id: REQUEST_ID,
          from: 'experts_invited',
          to: 'proposal_requested',
          actor: 'admin',
        })
      );
    });

    it('omits the transition event and time_from_first_eoi_ms when neither applies', async () => {
      mockRequestProposalAsAdmin.mockResolvedValue({
        success: true,
        expertProfileId: 'expert-1',
        transitioned: false,
        requestTransition: null,
        analytics: {
          proposalRequestCount: 2,
          timeFromFirstEoiMs: null,
          messageCount: 0,
          fileCount: 0,
        },
      });
      render(
        <AdminHealthPanel
          requestId={REQUEST_ID}
          status="experts_invited"
          relationships={[rel({ status: 'invited' })]}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /Request proposal from Priya Nair/i }));
      fireEvent.click(await screen.findByRole('button', { name: /^Request proposal$/i }));

      await waitFor(() => expect(mockRequestProposalAsAdmin).toHaveBeenCalled());
      const transitionCall = mockTrack.mock.calls.find(
        (c) => c[0] === PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED
      );
      expect(transitionCall).toBeUndefined();
      const proposalCall = mockTrack.mock.calls.find(
        (c) => c[0] === PROJECT_EVENTS.PROJECT_PROPOSAL_REQUESTED
      );
      expect(proposalCall?.[1]).not.toHaveProperty('time_from_first_eoi_ms');
    });

    it('shows an error toast and fires no analytics when the action fails', async () => {
      mockRequestProposalAsAdmin.mockResolvedValue({
        success: false,
        error: 'A proposal has already been requested from this expert.',
      });
      render(
        <AdminHealthPanel
          requestId={REQUEST_ID}
          status="experts_invited"
          relationships={[rel({ status: 'invited' })]}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /Request proposal from Priya Nair/i }));
      fireEvent.click(await screen.findByRole('button', { name: /^Request proposal$/i }));

      await waitFor(() =>
        expect(mockToast.error).toHaveBeenCalledWith(
          'A proposal has already been requested from this expert.'
        )
      );
      expect(mockToast.success).not.toHaveBeenCalled();
      expect(mockTrack).not.toHaveBeenCalled();
    });
  });
});
