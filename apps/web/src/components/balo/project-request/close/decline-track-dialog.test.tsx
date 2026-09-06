import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import type { DeclineTrackActionResult } from '@/app/(dashboard)/projects/[requestId]/_actions/decline-track';
import type { DeclineTrackAsAdminActionResult } from '@/app/(dashboard)/projects/[requestId]/_actions/decline-track-as-admin';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const declineTrackAction = vi.fn<(input: unknown) => Promise<DeclineTrackActionResult>>();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/decline-track', () => ({
  declineTrackAction: (input: unknown) => declineTrackAction(input),
}));

const declineTrackAsAdminAction =
  vi.fn<(input: unknown) => Promise<DeclineTrackAsAdminActionResult>>();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/decline-track-as-admin', () => ({
  declineTrackAsAdminAction: (input: unknown) => declineTrackAsAdminAction(input),
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

import { DeclineTrackDialog } from './decline-track-dialog';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-2222-2222-222222222222';
const mockToast = vi.mocked(toast);
const mockTrack = vi.mocked(track);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeclineTrackDialog — verb and body switch on stage', () => {
  it('invited: verb is "Withdraw invite", body mentions the invitation only', () => {
    render(
      <DeclineTrackDialog
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST_ID}
        relationshipId={RELATIONSHIP_ID}
        expertName="Aisha Bello"
        partyLabel="CloudPeak"
        companyName="Northwind Industrial"
        stage="invited"
        variant="client"
      />
    );
    expect(screen.getByText('Withdraw Aisha Bello’s invitation?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Withdraw invite/i })).toBeInTheDocument();
    expect(screen.getByText(/invitation was withdrawn/)).toBeInTheDocument();
  });

  it('proposal_submitted: verb is "Decline", body mentions the proposal + files rule', () => {
    render(
      <DeclineTrackDialog
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST_ID}
        relationshipId={RELATIONSHIP_ID}
        expertName="Priya Nair"
        partyLabel="CloudPeak"
        companyName="Northwind Industrial"
        stage="proposal_submitted"
        variant="client"
      />
    );
    expect(screen.getByText('Decline Priya Nair’s proposal?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Decline$/i })).toBeInTheDocument();
    expect(screen.getByText(/proposal is declined/)).toBeInTheDocument();
  });
});

describe('DeclineTrackDialog — admin variant shows the on-behalf line', () => {
  it('renders the shield attribution line naming the company', () => {
    render(
      <DeclineTrackDialog
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST_ID}
        relationshipId={RELATIONSHIP_ID}
        expertName="Priya Nair"
        partyLabel="CloudPeak"
        companyName="Northwind Industrial"
        stage="eoi_submitted"
        variant="admin"
      />
    );
    expect(screen.getByText(/on Northwind Industrial’s behalf/)).toBeInTheDocument();
  });

  it('client variant never shows the on-behalf line', () => {
    render(
      <DeclineTrackDialog
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST_ID}
        relationshipId={RELATIONSHIP_ID}
        expertName="Priya Nair"
        partyLabel="CloudPeak"
        companyName="Northwind Industrial"
        stage="eoi_submitted"
        variant="client"
      />
    );
    expect(screen.queryByText(/behalf/)).not.toBeInTheDocument();
  });
});

describe('DeclineTrackDialog — submit flow', () => {
  const SUCCESS: DeclineTrackActionResult = {
    success: true,
    analytics: { stage: 'eoi_submitted', actorKind: 'client', hadOpenProposal: false },
  };

  it('calls declineTrackAction, tracks, toasts, closes and refreshes on success', async () => {
    const user = userEvent.setup();
    declineTrackAction.mockResolvedValue(SUCCESS);
    const onOpenChange = vi.fn();
    render(
      <DeclineTrackDialog
        open
        onOpenChange={onOpenChange}
        requestId={REQUEST_ID}
        relationshipId={RELATIONSHIP_ID}
        expertName="Marcus Lee"
        partyLabel="Northstar Consulting"
        companyName="Northwind Industrial"
        stage="eoi_submitted"
        variant="client"
      />
    );
    await user.click(screen.getByRole('button', { name: /^Decline$/i }));

    await waitFor(() =>
      expect(declineTrackAction).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: RELATIONSHIP_ID,
      })
    );
    expect(mockTrack).toHaveBeenCalledWith(
      'project_track_declined',
      expect.objectContaining({ request_id: REQUEST_ID, relationship_id: RELATIONSHIP_ID })
    );
    expect(mockToast.success).toHaveBeenCalledWith('Declined — Northstar Consulting has been told');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalled();
  });

  it('calls declineTrackAsAdminAction for the admin variant', async () => {
    const user = userEvent.setup();
    declineTrackAsAdminAction.mockResolvedValue({
      success: true,
      analytics: { stage: 'invited', actorKind: 'balo', hadOpenProposal: false },
    });
    render(
      <DeclineTrackDialog
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST_ID}
        relationshipId={RELATIONSHIP_ID}
        expertName="Aisha Bello"
        partyLabel="CloudPeak"
        companyName="Northwind Industrial"
        stage="invited"
        variant="admin"
      />
    );
    await user.click(screen.getByRole('button', { name: /Withdraw invite/i }));
    await waitFor(() =>
      expect(declineTrackAsAdminAction).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: RELATIONSHIP_ID,
      })
    );
    expect(mockToast.success).toHaveBeenCalledWith('Invite withdrawn — CloudPeak has been told');
  });

  it('toasts the error and stays open on failure', async () => {
    const user = userEvent.setup();
    declineTrackAction.mockResolvedValue({ success: false, error: 'Nope.' });
    const onOpenChange = vi.fn();
    render(
      <DeclineTrackDialog
        open
        onOpenChange={onOpenChange}
        requestId={REQUEST_ID}
        relationshipId={RELATIONSHIP_ID}
        expertName="Marcus Lee"
        partyLabel="Northstar Consulting"
        companyName="Northwind Industrial"
        stage="eoi_submitted"
        variant="client"
      />
    );
    await user.click(screen.getByRole('button', { name: /^Decline$/i }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Nope.'));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
