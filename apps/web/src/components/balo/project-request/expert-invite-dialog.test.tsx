import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/utils';
import type { ExpertInviteOption } from '@/app/(dashboard)/projects/[requestId]/_actions/search-experts-for-invite';

const mockSearchExperts = vi.fn();
const mockInviteExperts = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/search-experts-for-invite', () => ({
  searchExpertsForInviteAction: (...args: unknown[]) => mockSearchExperts(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/invite-experts', () => ({
  inviteExpertsAction: (...args: unknown[]) => mockInviteExperts(...args),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { toast } from 'sonner';
import { ExpertInviteDialog } from './expert-invite-dialog';
import { track, PROJECT_EVENTS } from '@/lib/analytics';

const mockToast = vi.mocked(toast);

const REQUEST_ID = 'req-1';

function expert(id: string, name: string): ExpertInviteOption {
  return { id, name, headline: `${name} headline`, avatarUrl: null };
}

function renderOpen(props: Partial<React.ComponentProps<typeof ExpertInviteDialog>> = {}) {
  return render(
    <ExpertInviteDialog
      open
      onOpenChange={vi.fn()}
      requestId={REQUEST_ID}
      alreadyInvitedIds={[]}
      {...props}
    />
  );
}

describe('ExpertInviteDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading state while searching', async () => {
    let resolve: (v: unknown) => void = () => {};
    mockSearchExperts.mockReturnValue(new Promise((r) => (resolve = r)));
    renderOpen();
    expect(await screen.findByText(/Loading experts/i)).toBeInTheDocument();
    resolve({ success: true, experts: [] });
    // Flush the resolved search so the act() warning doesn't leak across tests.
    await screen.findByText('No experts match');
  });

  it('shows an empty state when no experts match', async () => {
    mockSearchExperts.mockResolvedValue({ success: true, experts: [] });
    renderOpen();
    expect(await screen.findByText('No experts match')).toBeInTheDocument();
  });

  it('shows an error state with retry when the search fails', async () => {
    mockSearchExperts.mockResolvedValue({ success: false, error: 'boom' });
    renderOpen();
    expect(await screen.findByText(/Couldn't load experts/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('renders selectable result rows', async () => {
    mockSearchExperts.mockResolvedValue({
      success: true,
      experts: [expert('e-1', 'Priya Nair'), expert('e-2', 'Sofia Ruiz')],
    });
    renderOpen();
    expect(await screen.findByText('Priya Nair')).toBeInTheDocument();
    expect(screen.getByText('Sofia Ruiz')).toBeInTheDocument();
  });

  it('disables an already-invited expert', async () => {
    mockSearchExperts.mockResolvedValue({
      success: true,
      experts: [expert('e-1', 'Priya Nair')],
    });
    renderOpen({ alreadyInvitedIds: ['e-1'] });
    await screen.findByText('Priya Nair');
    expect(screen.getByText('Already invited')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Priya Nair/i })).toBeDisabled();
  });

  it('multi-selects and invites, firing analytics + a success toast', async () => {
    mockSearchExperts.mockResolvedValue({
      success: true,
      experts: [expert('e-1', 'Priya Nair'), expert('e-2', 'Sofia Ruiz')],
    });
    mockInviteExperts.mockResolvedValue({
      success: true,
      invitedCount: 2,
      transitioned: true,
      from: 'requested',
      firstAdminActionMs: 500,
      invited: [
        { relationshipId: 'rel-1', expertProfileId: 'e-1' },
        { relationshipId: 'rel-2', expertProfileId: 'e-2' },
      ],
    });
    const onOpenChange = vi.fn();
    renderOpen({ onOpenChange });

    fireEvent.click(await screen.findByRole('button', { name: /Priya Nair/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sofia Ruiz/i }));

    const confirm = screen.getByRole('button', { name: /Invite 2 experts/i });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mockInviteExperts).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        expertProfileIds: ['e-1', 'e-2'],
      })
    );
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_EXPERT_INVITED, {
      request_id: REQUEST_ID,
      relationship_id: 'rel-1',
      expert_id: 'e-1',
      actor: 'admin',
    });
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
      request_id: REQUEST_ID,
      from: 'requested',
      to: 'experts_invited',
      actor: 'admin',
      time_to_first_admin_action_ms: 500,
    });
    expect(mockToast.success).toHaveBeenCalledWith('2 experts invited.');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('toasts info and closes when every selection was already invited', async () => {
    mockSearchExperts.mockResolvedValue({
      success: true,
      experts: [expert('e-1', 'Priya Nair')],
    });
    mockInviteExperts.mockResolvedValue({
      success: true,
      invitedCount: 0,
      transitioned: false,
      invited: [],
    });
    const onOpenChange = vi.fn();
    renderOpen({ onOpenChange });
    fireEvent.click(await screen.findByRole('button', { name: /Priya Nair/i }));
    fireEvent.click(screen.getByRole('button', { name: /Invite 1 expert/i }));
    await waitFor(() => expect(mockToast.info).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('toasts the error when the invite action fails', async () => {
    mockSearchExperts.mockResolvedValue({
      success: true,
      experts: [expert('e-1', 'Priya Nair')],
    });
    mockInviteExperts.mockResolvedValue({ success: false, error: 'nope' });
    renderOpen();
    fireEvent.click(await screen.findByRole('button', { name: /Priya Nair/i }));
    fireEvent.click(screen.getByRole('button', { name: /Invite 1 expert/i }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('nope'));
  });
});
