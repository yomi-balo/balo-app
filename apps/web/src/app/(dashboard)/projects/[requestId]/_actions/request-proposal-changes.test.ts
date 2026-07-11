import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
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
  mockRequestChanges,
  mockCreateChangeRequest,
  InvalidProposalTransitionError,
} = vi.hoisted(() => {
  class InvalidProposalTransitionError extends Error {}
  return {
    mockFindById: vi.fn(),
    mockRequestChanges: vi.fn(),
    mockCreateChangeRequest: vi.fn(),
    InvalidProposalTransitionError,
  };
});

vi.mock('@balo/db', () => ({
  proposalsRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    requestChanges: (...a: unknown[]) => mockRequestChanges(...a),
  },
  proposalChangeRequestsRepository: {
    create: (...a: unknown[]) => mockCreateChangeRequest(...a),
  },
  InvalidProposalTransitionError,
}));

import { requestProposalChangesAction } from './request-proposal-changes';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const USER = { id: 'user-client', firstName: 'Grace', lastName: 'Hopper' };

const VALID_INPUT = {
  requestId: REQUEST_ID,
  relationshipId: REL_ID,
  proposalId: PROPOSAL_ID,
  section: 'milestones' as const,
  note: 'Please split milestone 2 into two phases.',
};

const PROPOSAL = {
  id: PROPOSAL_ID,
  status: 'submitted',
  relationshipId: REL_ID,
  isCurrent: true,
};

function accessOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    ctx: { lens: 'client' },
    relationship: { expertProfileId: EXPERT_PROFILE_ID, status: 'proposal_submitted' },
    request: { status: 'proposal_submitted', title: 'CPQ implementation' },
    recipient: { role: 'expert', expertProfileId: EXPERT_PROFILE_ID },
    ...overrides,
  };
}

describe('requestProposalChangesAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue(accessOk());
    mockFindById.mockResolvedValue({ ...PROPOSAL });
    mockRequestChanges.mockResolvedValue({ id: 'change-req-1' });
    mockPublish.mockResolvedValue(undefined);
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await requestProposalChangesAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('rejects invalid input (bad proposalId)', async () => {
    expect(await requestProposalChangesAction({ ...VALID_INPUT, proposalId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('rejects an empty note', async () => {
    const result = await requestProposalChangesAction({ ...VALID_INPUT, note: '   ' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('bubbles the access guard error', async () => {
    mockResolveAccess.mockResolvedValue({
      ok: false,
      error: 'You do not have access to this conversation.',
    });
    expect(await requestProposalChangesAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You do not have access to this conversation.',
    });
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('blocks a non-client (expert) lens', async () => {
    mockResolveAccess.mockResolvedValue(accessOk({ ctx: { lens: 'expert' } }));
    expect(await requestProposalChangesAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Only the client can request changes on a proposal.',
    });
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('blocks an admin lens', async () => {
    mockResolveAccess.mockResolvedValue(accessOk({ ctx: { lens: 'admin' } }));
    expect(await requestProposalChangesAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Only the client can request changes on a proposal.',
    });
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('rejects when the proposal is not found (stale)', async () => {
    mockFindById.mockResolvedValue(undefined);
    expect(await requestProposalChangesAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal has already moved on. Refresh to see the latest.',
    });
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('rejects a proposal that is not submitted (stale)', async () => {
    mockFindById.mockResolvedValue({ ...PROPOSAL, status: 'changes_requested' });
    expect(await requestProposalChangesAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal has already moved on. Refresh to see the latest.',
    });
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('rejects a proposal belonging to a different relationship (stale)', async () => {
    mockFindById.mockResolvedValue({ ...PROPOSAL, relationshipId: 'other-rel' });
    expect(await requestProposalChangesAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal has already moved on. Refresh to see the latest.',
    });
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('rejects a non-current proposal (stale)', async () => {
    mockFindById.mockResolvedValue({ ...PROPOSAL, isCurrent: false });
    expect(await requestProposalChangesAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal has already moved on. Refresh to see the latest.',
    });
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('requests changes via the SINGLE atomic repo call, publishes, and returns success', async () => {
    const result = await requestProposalChangesAction(VALID_INPUT);

    // Success carries the real expert profile id (the analytics `expert_id`).
    expect(result).toEqual({ success: true, expertProfileId: EXPERT_PROFILE_ID });

    // Single atomic call with exactly the required args.
    expect(mockRequestChanges).toHaveBeenCalledTimes(1);
    expect(mockRequestChanges).toHaveBeenCalledWith({
      proposalId: PROPOSAL_ID,
      requestedByUserId: USER.id,
      section: 'milestones',
      note: 'Please split milestone 2 into two phases.',
    });

    // Does NOT also call the raw change-request create (that would double-insert).
    expect(mockCreateChangeRequest).not.toHaveBeenCalled();

    // Publishes the expert-targeted change-request notification.
    expect(mockPublish).toHaveBeenCalledWith('project.changes_requested', {
      correlationId: PROPOSAL_ID,
      projectRequestId: REQUEST_ID,
      relationshipId: REL_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      clientName: 'Grace Hopper',
      projectTitle: 'CPQ implementation',
      section: 'milestones',
      note: 'Please split milestone 2 into two phases.',
    });

    expect(log.info).toHaveBeenCalledWith('Proposal changes requested', expect.any(Object));

    // Revalidates BOTH the request-detail page and the proposal surface.
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}/proposal/${REL_ID}`);
  });

  it('defaults the section to "general" when omitted', async () => {
    const withoutSection = {
      requestId: REQUEST_ID,
      relationshipId: REL_ID,
      proposalId: PROPOSAL_ID,
      note: VALID_INPUT.note,
    };
    await requestProposalChangesAction(withoutSection);
    expect(mockRequestChanges).toHaveBeenCalledWith(
      expect.objectContaining({ section: 'general' })
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'project.changes_requested',
      expect.objectContaining({ section: 'general' })
    );
  });

  it('trims the note before persisting', async () => {
    await requestProposalChangesAction({ ...VALID_INPUT, note: '  trim me  ' });
    expect(mockRequestChanges).toHaveBeenCalledWith(expect.objectContaining({ note: 'trim me' }));
  });

  it('maps a stale request (InvalidProposalTransitionError) to stale copy', async () => {
    mockRequestChanges.mockRejectedValue(new InvalidProposalTransitionError());
    expect(await requestProposalChangesAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal has already moved on. Refresh to see the latest.',
    });
  });

  it('maps an unexpected failure to the generic error and logs it (outer catch)', async () => {
    mockRequestChanges.mockRejectedValue(new Error('db down'));
    expect(await requestProposalChangesAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Could not request changes. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith('Request proposal changes failed', expect.any(Object));
  });

  it('does not fail the action when the notification publish rejects', async () => {
    mockPublish.mockRejectedValue(new Error('engine down'));
    const result = await requestProposalChangesAction(VALID_INPUT);
    expect(result).toEqual({ success: true, expertProfileId: EXPERT_PROFILE_ID });
    expect(mockRequestChanges).toHaveBeenCalledTimes(1);
  });
});
