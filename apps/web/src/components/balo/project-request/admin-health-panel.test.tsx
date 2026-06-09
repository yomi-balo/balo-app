import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/utils';
import type { RequestRelationshipView } from '@/lib/project-request/request-detail-view';

const mockRemove = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/remove-invited-expert', () => ({
  removeInvitedExpertAction: (...args: unknown[]) => mockRemove(...args),
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
import { AdminHealthPanel } from './admin-health-panel';

const mockToast = vi.mocked(toast);

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
});
