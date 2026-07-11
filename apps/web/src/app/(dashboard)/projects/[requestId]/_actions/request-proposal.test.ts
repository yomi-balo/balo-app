import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Real error class (hoisted) so the action's `instanceof` check is exercised
// even though `vi.mock` factories run before module-body consts.
const { InvalidRelationshipTransitionError } = vi.hoisted(() => {
  class InvalidRelationshipTransitionError extends Error {
    constructor(
      public readonly from: string,
      public readonly to: string
    ) {
      super(`Invalid relationship: ${from} → ${to}`);
      this.name = 'InvalidRelationshipTransitionError';
    }
  }
  return { InvalidRelationshipTransitionError };
});

const mockFindById = vi.fn();
const mockRelationshipTransition = vi.fn();
const mockCountThreadActivity = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    // BAL-295: the request rollup is derived inside the relationship transition;
    // the action re-reads the stored status via findById to source `transitioned`.
    findById: (...args: unknown[]) => mockFindById(...args),
  },
  requestExpertRelationshipsRepository: {
    transitionStatus: (...args: unknown[]) => mockRelationshipTransition(...args),
  },
  conversationsRepository: {
    countThreadActivity: (...args: unknown[]) => mockCountThreadActivity(...args),
  },
  InvalidRelationshipTransitionError,
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { requestProposalAction } from './request-proposal';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const CLIENT_USER = { id: 'user-client', companyId: 'company-1', platformRole: 'user' };
const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: RELATIONSHIP_ID };

interface AccessOptions {
  lens?: 'client' | 'expert';
  requestStatus?: string;
  relationshipStatus?: string;
  /** Other relationships on the request (proposalRequestCount / first-EOI math). */
  otherRelationships?: Array<Record<string, unknown>>;
  /** This relationship's hydrated newest live EOI submittedAt. */
  eoiSubmittedAt?: Date | null;
}

/** Build a resolved `ConversationAccess` success the way the real resolver shapes it. */
function access(opts: AccessOptions = {}): Record<string, unknown> {
  const {
    lens = 'client',
    requestStatus = 'eoi_submitted',
    relationshipStatus = 'eoi_submitted',
    otherRelationships = [],
    eoiSubmittedAt = new Date(Date.now() - 120_000),
  } = opts;
  const relationship = {
    id: RELATIONSHIP_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    status: relationshipStatus,
    expressionsOfInterest: eoiSubmittedAt === null ? [] : [{ submittedAt: eoiSubmittedAt }],
  };
  return {
    ok: true,
    ctx: { lens },
    request: {
      id: REQUEST_ID,
      status: requestStatus,
      title: 'CPQ implementation',
      relationships: [relationship, ...otherRelationships],
    },
    relationship,
    recipient: { role: 'expert', expertProfileId: EXPERT_PROFILE_ID },
  };
}

describe('requestProposalAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(CLIENT_USER);
    mockResolveAccess.mockResolvedValue(access());
    mockRelationshipTransition.mockResolvedValue({ id: RELATIONSHIP_ID });
    // Default re-read: the rollup advanced eoi_submitted → proposal_requested (the
    // access pre-op floor is `eoi_submitted`), so `transitioned` is true.
    mockFindById.mockResolvedValue({ id: REQUEST_ID, status: 'proposal_requested' });
    mockCountThreadActivity.mockResolvedValue({ messageCount: 7, fileCount: 2 });
    mockPublish.mockResolvedValue(undefined);
  });

  it('rejects an unauthenticated caller', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await requestProposalAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockRelationshipTransition).not.toHaveBeenCalled();
  });

  it('rejects invalid ids before touching the graph', async () => {
    const result = await requestProposalAction({ requestId: 'nope', relationshipId: 'also-nope' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockResolveAccess).not.toHaveBeenCalled();
  });

  it('surfaces the uniform access denial (non-participant / admin / closed / foreign id)', async () => {
    mockResolveAccess.mockResolvedValue({
      ok: false,
      error: 'You do not have access to this conversation.',
    });
    const result = await requestProposalAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You do not have access to this conversation.',
    });
    expect(mockRelationshipTransition).not.toHaveBeenCalled();
  });

  it('rejects the expert lens (access admits their own thread — the lens guard must not)', async () => {
    mockResolveAccess.mockResolvedValue(access({ lens: 'expert' }));
    const result = await requestProposalAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Only the client can request a proposal.' });
    expect(mockRelationshipTransition).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it.each(['proposal_requested', 'proposal_submitted', 'accepted'])(
    'pre-check: relationship already %s → friendly already_requested copy',
    async (relationshipStatus) => {
      mockResolveAccess.mockResolvedValue(access({ relationshipStatus }));
      const result = await requestProposalAction(VALID_INPUT);
      expect(result).toEqual({
        success: false,
        error: "You've already requested a proposal from this expert.",
        code: 'already_requested',
      });
      expect(mockRelationshipTransition).not.toHaveBeenCalled();
    }
  );

  it('pre-check: any other non-eoi_submitted relationship status → no-longer-available copy', async () => {
    mockResolveAccess.mockResolvedValue(access({ relationshipStatus: 'invited' }));
    const result = await requestProposalAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You can no longer request a proposal from this expert.',
    });
    expect(mockRelationshipTransition).not.toHaveBeenCalled();
  });

  it('happy path: advances the relationship guarded, re-reads the rollup-derived request status, returns analytics', async () => {
    const result = await requestProposalAction(VALID_INPUT);

    expect(mockRelationshipTransition).toHaveBeenCalledWith({
      id: RELATIONSHIP_ID,
      to: 'proposal_requested',
      expectedFrom: 'eoi_submitted',
    });
    // BAL-295: the action no longer issues a request transition — the relationship
    // transition derives it. It re-reads the stored status to source `transitioned`.
    expect(mockFindById).toHaveBeenCalledWith(REQUEST_ID);
    expect(mockCountThreadActivity).toHaveBeenCalledWith(RELATIONSHIP_ID);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.transitioned).toBe(true);
      expect(result.expertProfileId).toBe(EXPERT_PROFILE_ID);
      expect(result.analytics.proposalRequestCount).toBe(1);
      expect(result.analytics.timeFromFirstEoiMs).toBeGreaterThanOrEqual(0);
      expect(result.analytics.messageCount).toBe(7);
      expect(result.analytics.fileCount).toBe(2);
    }
    expect(log.info).toHaveBeenCalledWith(
      'Proposal requested',
      expect.objectContaining({ requestId: REQUEST_ID, transitioned: true })
    );
  });

  it('publishes project.proposal_requested to the expert with correlationId = relationshipId', async () => {
    await requestProposalAction(VALID_INPUT);
    expect(mockPublish).toHaveBeenCalledWith('project.proposal_requested', {
      correlationId: RELATIONSHIP_ID,
      projectRequestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'CPQ implementation',
      // BAL-315: client-initiated publishes now tag the initiator; no recipientId.
      initiatedBy: 'client',
    });
  });

  it('second proposal request (request already proposal_requested): re-read unchanged → transitioned:false', async () => {
    mockResolveAccess.mockResolvedValue(access({ requestStatus: 'proposal_requested' }));
    // The request was already proposal_requested (the pre-op floor) → re-read unchanged.
    mockFindById.mockResolvedValue({ id: REQUEST_ID, status: 'proposal_requested' });
    const result = await requestProposalAction(VALID_INPUT);
    expect(mockRelationshipTransition).toHaveBeenCalled();
    expect(result.success && result.transitioned).toBe(false);
  });

  it('counts existing proposal-phase relationships into proposal_request_count (incl. this one)', async () => {
    mockResolveAccess.mockResolvedValue(
      access({
        requestStatus: 'proposal_requested',
        otherRelationships: [
          {
            id: OTHER_RELATIONSHIP_ID,
            expertProfileId: 'other-expert',
            status: 'proposal_requested',
            expressionsOfInterest: [{ submittedAt: new Date(Date.now() - 600_000) }],
          },
        ],
      })
    );
    const result = await requestProposalAction(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.analytics.proposalRequestCount).toBe(2);
      // The OTHER relationship's older EOI is the request's first EOI.
      expect(result.analytics.timeFromFirstEoiMs).toBeGreaterThanOrEqual(600_000);
    }
  });

  it('returns null timeFromFirstEoiMs when no live EOI resolves', async () => {
    mockResolveAccess.mockResolvedValue(access({ eoiSubmittedAt: null }));
    const result = await requestProposalAction(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.analytics.timeFromFirstEoiMs).toBeNull();
    }
  });

  it('concurrent double-click (InvalidRelationshipTransitionError) → already_requested, not generic', async () => {
    mockRelationshipTransition.mockRejectedValue(
      new InvalidRelationshipTransitionError('proposal_requested', 'proposal_requested')
    );
    const result = await requestProposalAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: "You've already requested a proposal from this expert.",
      code: 'already_requested',
    });
    // The relationship transition threw before any re-read → no findById, no publish.
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('re-read snapshot race (another thread advanced the request further) → success; transitioned reflects the stored column', async () => {
    // The re-read can land AFTER a concurrent thread advanced the request further;
    // the action reports the committed status truthfully (still differs from the
    // pre-op floor → transitioned:true) and never errors.
    mockFindById.mockResolvedValue({ id: REQUEST_ID, status: 'proposal_submitted' });
    const result = await requestProposalAction(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.transitioned).toBe(true);
    // The relationship transition stands — still notify + revalidate.
    expect(mockPublish).toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('a rejected notification publish never fails the commit', async () => {
    mockPublish.mockRejectedValue(new Error('queue down'));
    const result = await requestProposalAction(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it('revalidates the request path on success', async () => {
    await requestProposalAction(VALID_INPUT);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('maps unexpected failures to the generic copy and logs the original error', async () => {
    mockRelationshipTransition.mockRejectedValue(new Error('DB down'));
    const result = await requestProposalAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not request the proposal. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to request proposal',
      expect.objectContaining({ error: 'DB down' })
    );
  });
});
