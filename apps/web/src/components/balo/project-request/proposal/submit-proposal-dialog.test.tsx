import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import type { SubmitProposalResult } from '@/app/(dashboard)/projects/[requestId]/_actions/submit-proposal';
import type {
  ResubmitProposalInput,
  ResubmitProposalResult,
} from '@/app/(dashboard)/projects/[requestId]/_actions/resubmit-proposal';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

// Mock the server action module (type-only + runtime import).
const submitProposalAction = vi.fn<(input: unknown) => Promise<SubmitProposalResult>>();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/submit-proposal', () => ({
  submitProposalAction: (input: unknown) => submitProposalAction(input),
}));

const resubmitProposalAction = vi.fn<(input: unknown) => Promise<ResubmitProposalResult>>();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/resubmit-proposal', () => ({
  resubmitProposalAction: (input: unknown) => resubmitProposalAction(input),
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
  analytics: {
    priceCents: 5_800_000,
    currency: 'aud',
    totalEstimatedMinutes: 0,
    pricingMethod: 'fixed',
    milestoneCount: 3,
  },
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

  it('confirm calls submitProposalAction, fires the client analytics, toasts, and routes', async () => {
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
    // BAL-357: PROJECT_PROPOSAL_SUBMITTED is emitted SERVER-SIDE by the action — the
    // client must NEVER fire it (the fee + client price would leak to the browser).
    expect(mockTrack).not.toHaveBeenCalledWith('project_proposal_submitted', expect.anything());
    // BAL-294: the effort-estimated event fires once at submit with the server totals.
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.MILESTONE_EFFORT_ESTIMATED, {
      proposal_id: PROPOSAL_ID,
      milestone_count: 3,
      total_estimated_minutes: 0,
      pricing_method: 'fixed',
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

  it('threads T&M total_estimated_minutes + pricing_method into the client effort event', async () => {
    const user = userEvent.setup();
    submitProposalAction.mockResolvedValue({
      ...SUCCESS,
      analytics: {
        priceCents: 125_000,
        currency: 'aud',
        totalEstimatedMinutes: 300,
        pricingMethod: 'tm',
        milestoneCount: 2,
      },
    });
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Submit proposal' }));

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.MILESTONE_EFFORT_ESTIMATED, {
        proposal_id: PROPOSAL_ID,
        milestone_count: 2,
        total_estimated_minutes: 300,
        pricing_method: 'tm',
      })
    );
    // The submitted event is server-emitted (BAL-357) — never fired client-side.
    expect(mockTrack).not.toHaveBeenCalledWith('project_proposal_submitted', expect.anything());
  });

  it('does NOT fire the transition event when result.transitioned is false', async () => {
    const user = userEvent.setup();
    submitProposalAction.mockResolvedValue({ ...SUCCESS, transitioned: false });
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Submit proposal' }));

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(
        PROJECT_EVENTS.MILESTONE_EFFORT_ESTIMATED,
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

  it('fires PROPOSAL_COHERENCE_REJECTED on a coherence failure, toasts generic copy, stays open', async () => {
    const user = userEvent.setup();
    submitProposalAction.mockResolvedValue({
      success: false,
      error:
        "This proposal's pricing is incomplete or inconsistent. Refresh and re-check the pricing details before submitting.",
      coherence: {
        rule: 'installments_not_100',
        pricingMethod: 'fixed',
        proposalId: PROPOSAL_ID,
        relationshipId: RELATIONSHIP_ID,
      },
    });
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Submit proposal' }));

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_COHERENCE_REJECTED, {
        rule: 'installments_not_100',
        pricing_method: 'fixed',
        entry_point: 'web',
        proposal_id: PROPOSAL_ID,
        relationship_id: RELATIONSHIP_ID,
      })
    );
    // Generic copy toasted; raw rule never rendered; not a success/transition event.
    expect(mockToast.error).toHaveBeenCalledWith(
      "This proposal's pricing is incomplete or inconsistent. Refresh and re-check the pricing details before submitting."
    );
    // No success events on a coherence failure (the submitted event is server-only).
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.MILESTONE_EFFORT_ESTIMATED,
      expect.anything()
    );
    // Stays open to retry (generic failure copy, not the stale string).
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
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

const RESUBMIT_PAYLOAD: ResubmitProposalInput = {
  requestId: REQUEST_ID,
  relationshipId: RELATIONSHIP_ID,
  fromProposalId: PROPOSAL_ID,
  overview: '<p>revised scope</p>',
  pricingMethod: 'fixed',
  priceCents: 6_000_000,
  milestones: [],
  installments: [],
};

const RESUBMIT_SUCCESS: ResubmitProposalResult = {
  success: true,
  proposalId: 'f0000000-0000-4000-8000-000000000006',
  version: 2,
  expertProfileId: 'exp-9',
  analytics: { priceCents: 6_000_000, currency: 'aud' },
};

function renderResubmitDialog(): {
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  getPayload: ReturnType<typeof vi.fn<() => ResubmitProposalInput>>;
} {
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const getPayload = vi.fn<() => ResubmitProposalInput>(() => RESUBMIT_PAYLOAD);
  render(
    <SubmitProposalDialog
      open
      onOpenChange={onOpenChange}
      requestId={REQUEST_ID}
      relationshipId={RELATIONSHIP_ID}
      proposalId={PROPOSAL_ID}
      clientFirstName="Dana"
      onBeforeSubmit={() => Promise.resolve(PROPOSAL_ID)}
      resubmit={{ nextVersion: 2, getPayload }}
    />
  );
  return { onOpenChange, getPayload };
}

describe('SubmitProposalDialog — resubmit mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the resubmit copy + "Resubmit as v2" button', () => {
    renderResubmitDialog();
    expect(screen.getByText('Resubmit your revised proposal to Dana?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resubmit as v2' })).toBeInTheDocument();
    // It is NOT the first-submit copy / button.
    expect(screen.queryByText('Submit your proposal to Dana?')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit proposal' })).not.toBeInTheDocument();
  });

  it('confirm calls resubmitProposalAction (not submit) with the composer payload, fires PROPOSAL_RESUBMITTED, toasts, routes', async () => {
    const user = userEvent.setup();
    resubmitProposalAction.mockResolvedValue(RESUBMIT_SUCCESS);
    const { onOpenChange } = renderResubmitDialog();

    await user.click(screen.getByRole('button', { name: 'Resubmit as v2' }));

    await waitFor(() => expect(resubmitProposalAction).toHaveBeenCalledWith(RESUBMIT_PAYLOAD));
    // The first-submit action is never touched in resubmit mode.
    expect(submitProposalAction).not.toHaveBeenCalled();

    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_RESUBMITTED, {
      request_id: REQUEST_ID,
      relationship_id: RELATIONSHIP_ID,
      expert_id: 'exp-9',
      version: 2,
      price_cents: 6_000_000,
      currency: 'aud',
    });
    expect(mockToast.success).toHaveBeenCalledWith('Resubmitted as v2');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('stale-UI error closes and refreshes (nothing to retry)', async () => {
    const user = userEvent.setup();
    resubmitProposalAction.mockResolvedValue({
      success: false,
      error: 'This proposal has already been resubmitted. Refresh to continue.',
    });
    const { onOpenChange } = renderResubmitDialog();

    await user.click(screen.getByRole('button', { name: 'Resubmit as v2' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(refresh).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('generic error toasts and stays open to retry', async () => {
    const user = userEvent.setup();
    resubmitProposalAction.mockResolvedValue({
      success: false,
      error: 'Could not resubmit your proposal. Please try again.',
    });
    const { onOpenChange } = renderResubmitDialog();

    await user.click(screen.getByRole('button', { name: 'Resubmit as v2' }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Could not resubmit your proposal. Please try again.'
      )
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('fires PROPOSAL_COHERENCE_REJECTED on a coherence failure, toasts generic copy, stays open', async () => {
    const user = userEvent.setup();
    resubmitProposalAction.mockResolvedValue({
      success: false,
      error:
        "This proposal's pricing is incomplete or inconsistent. Refresh and re-check the pricing details before resubmitting.",
      coherence: {
        rule: 'tm_has_installments',
        pricingMethod: 'tm',
        proposalId: PROPOSAL_ID,
        relationshipId: RELATIONSHIP_ID,
      },
    });
    const { onOpenChange } = renderResubmitDialog();

    await user.click(screen.getByRole('button', { name: 'Resubmit as v2' }));

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_COHERENCE_REJECTED, {
        rule: 'tm_has_installments',
        pricing_method: 'tm',
        entry_point: 'web',
        proposal_id: PROPOSAL_ID,
        relationship_id: RELATIONSHIP_ID,
      })
    );
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROPOSAL_RESUBMITTED,
      expect.anything()
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(push).not.toHaveBeenCalled();
  });
});
