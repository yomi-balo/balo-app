import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import type { SubmitProposalResult } from '@/app/(dashboard)/projects/[requestId]/_actions/submit-proposal';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

// Mock the server action module (type-only + runtime import).
const submitProposalAction = vi.fn<(input: unknown) => Promise<SubmitProposalResult>>();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/submit-proposal', () => ({
  submitProposalAction: (input: unknown) => submitProposalAction(input),
}));

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

import { SubmitProposalDialog } from './submit-proposal-dialog';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-2222-2222-222222222222';
const PROPOSAL_ID = '33333333-3333-3333-3333-333333333333';

const mockToast = vi.mocked(toast);
const mockTrack = vi.mocked(track);

const SUCCESS: SubmitProposalResult = {
  success: true,
  proposalId: PROPOSAL_ID,
  expertProfileId: 'exp-1',
  transitioned: true,
  analytics: { priceCents: 5_800_000, currency: 'aud' },
};

function renderDialog(overrides: { onBeforeSubmit?: () => Promise<string | null> } = {}): {
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  onBeforeSubmit: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
} {
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const onBeforeSubmit = vi.fn<() => Promise<string | null>>(
    overrides.onBeforeSubmit ?? (() => Promise.resolve(PROPOSAL_ID))
  );
  render(
    <SubmitProposalDialog
      open
      onOpenChange={onOpenChange}
      requestId={REQUEST_ID}
      relationshipId={RELATIONSHIP_ID}
      proposalId={PROPOSAL_ID}
      clientFirstName="Dana"
      onBeforeSubmit={onBeforeSubmit}
    />
  );
  return { onOpenChange, onBeforeSubmit };
}

describe('SubmitProposalDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('frames the commit with the client name', () => {
    renderDialog();
    expect(screen.getByText('Submit your proposal to Dana?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeInTheDocument();
  });

  it('confirm calls submitProposalAction, fires both analytics, toasts, and routes', async () => {
    const user = userEvent.setup();
    submitProposalAction.mockResolvedValue(SUCCESS);
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Submit proposal' }));

    await waitFor(() =>
      expect(submitProposalAction).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        relationshipId: RELATIONSHIP_ID,
        proposalId: PROPOSAL_ID,
      })
    );
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_PROPOSAL_SUBMITTED, {
      request_id: REQUEST_ID,
      relationship_id: RELATIONSHIP_ID,
      expert_id: 'exp-1',
      price_cents: 5_800_000,
      currency: 'aud',
    });
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
      request_id: REQUEST_ID,
      from: 'proposal_requested',
      to: 'proposal_submitted',
      actor: 'expert',
    });
    expect(mockToast.success).toHaveBeenCalledWith('Proposal sent to Dana');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('does NOT fire the transition event when result.transitioned is false', async () => {
    const user = userEvent.setup();
    submitProposalAction.mockResolvedValue({ ...SUCCESS, transitioned: false });
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Submit proposal' }));

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(
        PROJECT_EVENTS.PROJECT_PROPOSAL_SUBMITTED,
        expect.anything()
      )
    );
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED,
      expect.anything()
    );
  });

  it('error path toasts the error and does NOT navigate (stays open to retry)', async () => {
    const user = userEvent.setup();
    submitProposalAction.mockResolvedValue({
      success: false,
      error: 'Add an overview before submitting.',
    });
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Submit proposal' }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('Add an overview before submitting.')
    );
    expect(push).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('stale-UI error closes and refreshes (nothing to retry)', async () => {
    const user = userEvent.setup();
    submitProposalAction.mockResolvedValue({
      success: false,
      error: 'This proposal can no longer be submitted.',
    });
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Submit proposal' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(refresh).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('blocks Escape (close) while a submit is in flight', async () => {
    const user = userEvent.setup();
    let resolve: (result: SubmitProposalResult) => void = () => {};
    submitProposalAction.mockReturnValue(
      new Promise<SubmitProposalResult>((res) => {
        resolve = res;
      })
    );
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Submit proposal' }));
    // Pending: both buttons disabled, Escape is swallowed by handleOpenChange.
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    resolve(SUCCESS);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('falls back to the prop proposalId when the flush returns null id but a value exists', async () => {
    const user = userEvent.setup();
    submitProposalAction.mockResolvedValue(SUCCESS);
    renderDialog({ onBeforeSubmit: () => Promise.resolve(null) });

    await user.click(screen.getByRole('button', { name: 'Submit proposal' }));

    await waitFor(() =>
      expect(submitProposalAction).toHaveBeenCalledWith(
        expect.objectContaining({ proposalId: PROPOSAL_ID })
      )
    );
  });
});
