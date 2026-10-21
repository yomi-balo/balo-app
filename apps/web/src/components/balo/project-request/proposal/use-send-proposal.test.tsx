import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
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
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace }),
  usePathname: () => '/projects/11111111-1111-1111-1111-111111111111/proposal/rel',
}));

import { useSendProposal } from './use-send-proposal';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-2222-2222-222222222222';
const PROPOSAL_ID = '33333333-3333-3333-3333-333333333333';
const PATHNAME = `/projects/${REQUEST_ID}/proposal/rel`;

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

interface HookOptions {
  onBeforeSubmit?: () => Promise<string | null>;
  resubmit?: boolean;
}

function setup(options: HookOptions = {}): {
  result: ReturnType<typeof renderHook<ReturnType<typeof useSendProposal>, unknown>>['result'];
  onSent: ReturnType<typeof vi.fn<(version: number) => void>>;
  onBeforeSubmit: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  getPayload: ReturnType<typeof vi.fn<() => ResubmitProposalInput>>;
} {
  const onSent = vi.fn<(version: number) => void>();
  const onBeforeSubmit = vi.fn<() => Promise<string | null>>(
    options.onBeforeSubmit ?? (() => Promise.resolve(PROPOSAL_ID))
  );
  const getPayload = vi.fn<() => ResubmitProposalInput>(() => RESUBMIT_PAYLOAD);
  const { result } = renderHook(() =>
    useSendProposal({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      companyName: 'Northwind',
      onBeforeSubmit,
      resubmit: options.resubmit ? { nextVersion: 2, getPayload } : undefined,
      onSent,
    })
  );
  return { result, onSent, onBeforeSubmit, getPayload };
}

describe('useSendProposal — first submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flushes first, submits with the flushed id, toasts, and reports version 1', async () => {
    submitProposalAction.mockResolvedValue(SUCCESS);
    const { result, onSent, onBeforeSubmit } = setup({
      onBeforeSubmit: () => Promise.resolve('flushed-id'),
    });

    act(() => result.current.send());

    await waitFor(() => expect(onSent).toHaveBeenCalledWith(1));
    expect(onBeforeSubmit).toHaveBeenCalledTimes(1);
    expect(submitProposalAction).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      proposalId: 'flushed-id',
    });
    expect(mockToast.success).toHaveBeenCalledWith('Proposal sent to Northwind');
    expect(replace).toHaveBeenCalledWith(`${PATHNAME}?sent=1`, { scroll: true });
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('never fires the server-emitted submitted event, but fires the effort event once', async () => {
    submitProposalAction.mockResolvedValue(SUCCESS);
    const { result, onSent } = setup();

    act(() => result.current.send());

    await waitFor(() => expect(onSent).toHaveBeenCalled());
    // BAL-357: PROJECT_PROPOSAL_SUBMITTED is emitted SERVER-SIDE by the action.
    expect(mockTrack).not.toHaveBeenCalledWith('project_proposal_submitted', expect.anything());
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
  });

  it('threads T&M total_estimated_minutes + pricing_method into the effort event', async () => {
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
    const { result } = setup();

    act(() => result.current.send());

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.MILESTONE_EFFORT_ESTIMATED, {
        proposal_id: PROPOSAL_ID,
        milestone_count: 2,
        total_estimated_minutes: 300,
        pricing_method: 'tm',
      })
    );
  });

  it('does NOT fire the transition event when result.transitioned is false', async () => {
    submitProposalAction.mockResolvedValue({ ...SUCCESS, transitioned: false });
    const { result, onSent } = setup();

    act(() => result.current.send());

    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED,
      expect.anything()
    );
  });

  it('toasts an error and never submits when the final save fails', async () => {
    const { result, onSent } = setup({ onBeforeSubmit: () => Promise.resolve(null) });

    act(() => result.current.send());

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Could not submit your proposal. Please try again.'
      )
    );
    expect(submitProposalAction).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it('a stale result toasts and refreshes without reporting a send', async () => {
    submitProposalAction.mockResolvedValue({
      success: false,
      error: 'This proposal can no longer be submitted.',
    });
    const { result, onSent } = setup();

    act(() => result.current.send());

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(mockToast.error).toHaveBeenCalledWith('This proposal can no longer be submitted.');
    expect(onSent).not.toHaveBeenCalled();
  });

  it('a generic error toasts, does not refresh, and never calls onSent', async () => {
    submitProposalAction.mockResolvedValue({
      success: false,
      error: 'Add an overview before submitting.',
    });
    const { result, onSent } = setup();

    act(() => result.current.send());

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('Add an overview before submitting.')
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  it('a thrown action falls back to the generic submit copy and clears pending', async () => {
    submitProposalAction.mockRejectedValue(new Error('network'));
    const { result, onSent } = setup();

    act(() => result.current.send());

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Could not submit your proposal. Please try again.'
      )
    );
    expect(onSent).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  it('fires PROPOSAL_COHERENCE_REJECTED on a coherence failure with generic copy only', async () => {
    const copy =
      "This proposal's pricing is incomplete or inconsistent. Refresh and re-check the pricing details before submitting.";
    submitProposalAction.mockResolvedValue({
      success: false,
      error: copy,
      coherence: {
        rule: 'installments_not_100',
        pricingMethod: 'fixed',
        proposalId: PROPOSAL_ID,
        relationshipId: RELATIONSHIP_ID,
      },
    });
    const { result, onSent } = setup();

    act(() => result.current.send());

    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_COHERENCE_REJECTED, {
        rule: 'installments_not_100',
        pricing_method: 'fixed',
        entry_point: 'web',
        proposal_id: PROPOSAL_ID,
        relationship_id: RELATIONSHIP_ID,
      })
    );
    expect(mockToast.error).toHaveBeenCalledWith(copy);
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.MILESTONE_EFFORT_ESTIMATED,
      expect.anything()
    );
    expect(onSent).not.toHaveBeenCalled();
  });

  it('reports pending while in flight and ignores a second send', async () => {
    let resolve: (result: SubmitProposalResult) => void = () => {};
    submitProposalAction.mockReturnValue(
      new Promise<SubmitProposalResult>((res) => {
        resolve = res;
      })
    );
    const { result, onSent, onBeforeSubmit } = setup();

    act(() => {
      result.current.send();
      result.current.send();
    });
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(submitProposalAction).toHaveBeenCalledTimes(1));
    expect(onBeforeSubmit).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(SUCCESS);
    });
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(result.current.pending).toBe(false);
  });
});

describe('useSendProposal — resubmit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls resubmitProposalAction (not submit) with the composer payload, fires PROPOSAL_RESUBMITTED, toasts, reports the version', async () => {
    resubmitProposalAction.mockResolvedValue(RESUBMIT_SUCCESS);
    const { result, onSent, onBeforeSubmit, getPayload } = setup({ resubmit: true });

    act(() => result.current.send());

    await waitFor(() => expect(onSent).toHaveBeenCalledWith(2));
    expect(getPayload).toHaveBeenCalledTimes(1);
    expect(resubmitProposalAction).toHaveBeenCalledWith(RESUBMIT_PAYLOAD);
    // Revise mode is local-only until the atomic resubmit: no flush, no first-submit action.
    expect(submitProposalAction).not.toHaveBeenCalled();
    expect(onBeforeSubmit).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_RESUBMITTED, {
      request_id: REQUEST_ID,
      relationship_id: RELATIONSHIP_ID,
      expert_id: 'exp-9',
      version: 2,
      price_cents: 6_000_000,
      currency: 'aud',
    });
    expect(mockToast.success).toHaveBeenCalledWith('Version 2 sent to Northwind');
    expect(replace).toHaveBeenCalledWith(`${PATHNAME}?sent=2`, { scroll: true });
    expect(push).not.toHaveBeenCalled();
  });

  it('a stale result toasts and refreshes without reporting a send', async () => {
    resubmitProposalAction.mockResolvedValue({
      success: false,
      error: 'This proposal has already been resubmitted. Refresh to continue.',
    });
    const { result, onSent } = setup({ resubmit: true });

    act(() => result.current.send());

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(mockToast.error).toHaveBeenCalledWith(
      'This proposal has already been resubmitted. Refresh to continue.'
    );
    expect(onSent).not.toHaveBeenCalled();
  });

  it('a generic error toasts and never calls onSent', async () => {
    resubmitProposalAction.mockResolvedValue({
      success: false,
      error: 'Could not resubmit your proposal. Please try again.',
    });
    const { result, onSent } = setup({ resubmit: true });

    act(() => result.current.send());

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Could not resubmit your proposal. Please try again.'
      )
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it('a thrown action falls back to the generic resubmit copy', async () => {
    resubmitProposalAction.mockRejectedValue(new Error('network'));
    const { result } = setup({ resubmit: true });

    act(() => result.current.send());

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Could not resubmit your proposal. Please try again.'
      )
    );
  });

  it('fires PROPOSAL_COHERENCE_REJECTED on a coherence failure and does not report a resubmit', async () => {
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
    const { result, onSent } = setup({ resubmit: true });

    act(() => result.current.send());

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
    expect(onSent).not.toHaveBeenCalled();
  });
});
