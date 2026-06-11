import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

const {
  mockFindById,
  mockAccept,
  mockTransitionRequest,
  InvalidProposalTransitionError,
  InvalidRelationshipTransitionError,
  InvalidStatusTransitionError,
} = vi.hoisted(() => {
  class InvalidProposalTransitionError extends Error {}
  class InvalidRelationshipTransitionError extends Error {}
  class InvalidStatusTransitionError extends Error {}
  return {
    mockFindById: vi.fn(),
    mockAccept: vi.fn(),
    mockTransitionRequest: vi.fn(),
    InvalidProposalTransitionError,
    InvalidRelationshipTransitionError,
    InvalidStatusTransitionError,
  };
});

vi.mock('@balo/db', () => ({
  proposalsRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    accept: (...a: unknown[]) => mockAccept(...a),
  },
  projectRequestsRepository: {
    transitionStatus: (...a: unknown[]) => mockTransitionRequest(...a),
  },
  InvalidProposalTransitionError,
  InvalidRelationshipTransitionError,
  InvalidStatusTransitionError,
}));

import { acceptProposalAction } from './accept-proposal';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const USER = { id: 'user-client', firstName: 'Grace', lastName: 'Hopper' };

const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: REL_ID, proposalId: PROPOSAL_ID };

const PROPOSAL = {
  id: PROPOSAL_ID,
  status: 'submitted',
  relationshipId: REL_ID,
  isCurrent: true,
  priceCents: 500000,
  currency: 'aud',
};

function accessOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    ctx: { lens: 'client' },
    relationship: { expertProfileId: EXPERT_PROFILE_ID, status: 'proposal_submitted' },
    request: {
      status: 'proposal_submitted',
      title: 'CPQ implementation',
      company: { name: 'Acme Corp' },
    },
    recipient: { role: 'expert', expertProfileId: EXPERT_PROFILE_ID },
    ...overrides,
  };
}

describe('acceptProposalAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue(accessOk());
    mockFindById.mockResolvedValue({ ...PROPOSAL });
    mockAccept.mockResolvedValue({ id: PROPOSAL_ID });
    mockTransitionRequest.mockResolvedValue({ id: REQUEST_ID });
    mockPublish.mockResolvedValue(undefined);
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await acceptProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('rejects invalid input', async () => {
    expect(await acceptProposalAction({ ...VALID_INPUT, proposalId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('bubbles the access guard error', async () => {
    mockResolveAccess.mockResolvedValue({
      ok: false,
      error: 'You do not have access to this conversation.',
    });
    expect(await acceptProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You do not have access to this conversation.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('blocks a non-client (expert) lens', async () => {
    mockResolveAccess.mockResolvedValue(accessOk({ ctx: { lens: 'expert' } }));
    expect(await acceptProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Only the client can accept a proposal.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('blocks an admin lens', async () => {
    mockResolveAccess.mockResolvedValue(accessOk({ ctx: { lens: 'admin' } }));
    expect(await acceptProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Only the client can accept a proposal.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('rejects when the proposal is not found', async () => {
    mockFindById.mockResolvedValue(undefined);
    expect(await acceptProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be accepted.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('rejects a proposal that is not submitted', async () => {
    mockFindById.mockResolvedValue({ ...PROPOSAL, status: 'draft' });
    expect(await acceptProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be accepted.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('rejects a proposal belonging to a different relationship', async () => {
    mockFindById.mockResolvedValue({ ...PROPOSAL, relationshipId: 'other-rel' });
    expect(await acceptProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be accepted.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('rejects a non-current proposal', async () => {
    mockFindById.mockResolvedValue({ ...PROPOSAL, isCurrent: false });
    expect(await acceptProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be accepted.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('accepts the proposal, advances the aggregate, publishes, and returns success', async () => {
    const result = await acceptProposalAction(VALID_INPUT);

    expect(result).toEqual({
      success: true,
      proposalId: PROPOSAL_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      transitioned: true,
    });

    // Commits the accept via the EXISTING repo method.
    expect(mockAccept).toHaveBeenCalledWith({ id: PROPOSAL_ID });

    // Advances the request aggregate from proposal_submitted → accepted.
    expect(mockTransitionRequest).toHaveBeenCalledWith({
      id: REQUEST_ID,
      to: 'accepted',
      expectedFrom: 'proposal_submitted',
    });

    // Publishes the acceptance notification with the winning expertProfileId.
    expect(mockPublish).toHaveBeenCalledWith('project.proposal_accepted', {
      correlationId: PROPOSAL_ID,
      projectRequestId: REQUEST_ID,
      relationshipId: REL_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      clientName: 'Grace Hopper',
      clientCompanyName: 'Acme Corp',
      title: 'CPQ implementation',
      priceCents: 500000,
      currency: 'aud',
    });

    expect(log.info).toHaveBeenCalledWith('Proposal accepted', expect.any(Object));

    // Revalidates BOTH the request-detail page and the proposal surface the
    // client accepted from (defensive — avoids a stale "still acceptable" state
    // on back-navigation).
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}/proposal/${REL_ID}`);
  });

  it('falls back to "their company" when the request has no company', async () => {
    mockResolveAccess.mockResolvedValue(
      accessOk({
        request: { status: 'proposal_submitted', title: 'CPQ implementation', company: null },
      })
    );
    await acceptProposalAction(VALID_INPUT);
    expect(mockPublish).toHaveBeenCalledWith(
      'project.proposal_accepted',
      expect.objectContaining({ clientCompanyName: 'their company' })
    );
  });

  it('maps a stale accept (proposal transition) to stale copy', async () => {
    mockAccept.mockRejectedValue(new InvalidProposalTransitionError());
    expect(await acceptProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be accepted.',
    });
  });

  it('maps a stale accept (relationship transition) to stale copy', async () => {
    mockAccept.mockRejectedValue(new InvalidRelationshipTransitionError());
    expect(await acceptProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be accepted.',
    });
  });

  it('tolerates a benign request-aggregate race (InvalidStatusTransitionError)', async () => {
    mockTransitionRequest.mockRejectedValue(new InvalidStatusTransitionError());
    const result = await acceptProposalAction(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.transitioned).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'Proposal accept request transition skipped (already advanced)',
      expect.any(Object)
    );
  });

  it('does not advance the request aggregate when it is already past proposal_submitted', async () => {
    mockResolveAccess.mockResolvedValue(
      accessOk({
        request: {
          status: 'accepted',
          title: 'CPQ implementation',
          company: { name: 'Acme Corp' },
        },
      })
    );
    const result = await acceptProposalAction(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.transitioned).toBe(false);
    expect(mockTransitionRequest).not.toHaveBeenCalled();
  });

  it('maps an unexpected accept failure to the generic error and logs it (outer catch)', async () => {
    // A PLAIN error (not a typed transition error) propagates to the outer catch.
    mockAccept.mockRejectedValue(new Error('db down'));
    expect(await acceptProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Could not accept this proposal. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith('Failed to accept proposal', expect.any(Object));
  });

  it('keeps the accept committed (success, transitioned:false) when the best-effort aggregate advance throws a non-race error', async () => {
    // A PLAIN error from transitionStatus (not InvalidStatusTransitionError) is
    // logged and swallowed — the already-committed accept must still succeed.
    mockTransitionRequest.mockRejectedValue(new Error('conn reset'));
    const result = await acceptProposalAction(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.transitioned).toBe(false);
    // The accept committed before the best-effort advance ran.
    expect(mockAccept).toHaveBeenCalledWith({ id: PROPOSAL_ID });
    expect(log.error).toHaveBeenCalledWith(
      'Request aggregate advance failed after accept commit',
      expect.any(Object)
    );
  });

  it('does not fail the action when the notification publish rejects', async () => {
    mockPublish.mockRejectedValue(new Error('engine down'));
    const result = await acceptProposalAction(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.transitioned).toBe(true);
    expect(mockAccept).toHaveBeenCalledWith({ id: PROPOSAL_ID });
  });
});
