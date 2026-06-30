import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000004';
const CREATED_BY_USER_ID = 'd0000000-0000-4000-8000-000000000005';

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

const mockFindByIdWithRelations = vi.fn();
const mockFindById = vi.fn();
const mockTransition = vi.fn();
const mockCountThreadActivity = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...args: unknown[]) => mockFindByIdWithRelations(...args),
    // The request rollup is derived inside the relationship transition; the action
    // re-reads the stored status via findById to source `transitioned`.
    findById: (...args: unknown[]) => mockFindById(...args),
  },
  requestExpertRelationshipsRepository: {
    transitionStatus: (...args: unknown[]) => mockTransition(...args),
  },
  conversationsRepository: {
    countThreadActivity: (...args: unknown[]) => mockCountThreadActivity(...args),
  },
  InvalidRelationshipTransitionError,
}));

const mockRequireAdmin = vi.fn();
vi.mock('@/lib/auth/require-admin', () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { requestProposalAsAdmin } from './request-proposal-as-admin';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: RELATIONSHIP_ID };

interface RequestOptions {
  requestStatus?: string;
  relationshipStatus?: string;
  otherRelationships?: Array<Record<string, unknown>>;
  eoiSubmittedAt?: Date | null;
}

/** Build a hydrated `findByIdWithRelations` result the way the real repo shapes it. */
function buildRequest(opts: RequestOptions = {}): Record<string, unknown> {
  const {
    requestStatus = 'experts_invited',
    relationshipStatus = 'invited',
    otherRelationships = [],
    eoiSubmittedAt = null,
  } = opts;
  const relationship = {
    id: RELATIONSHIP_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    status: relationshipStatus,
    expressionsOfInterest: eoiSubmittedAt === null ? [] : [{ submittedAt: eoiSubmittedAt }],
  };
  return {
    id: REQUEST_ID,
    status: requestStatus,
    title: 'CPQ implementation',
    createdByUserId: CREATED_BY_USER_ID,
    relationships: [relationship, ...otherRelationships],
  };
}

describe('requestProposalAsAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(ADMIN);
    mockFindByIdWithRelations.mockResolvedValue(buildRequest());
    mockTransition.mockResolvedValue({ id: RELATIONSHIP_ID });
    // Default re-read: the rollup advanced experts_invited → proposal_requested.
    mockFindById.mockResolvedValue({ id: REQUEST_ID, status: 'proposal_requested' });
    mockCountThreadActivity.mockResolvedValue({ messageCount: 4, fileCount: 1 });
    mockPublish.mockResolvedValue(undefined);
  });

  it('rejects a non-admin before touching the graph', async () => {
    mockRequireAdmin.mockRejectedValue(new Error('Forbidden'));
    const result = await requestProposalAsAdmin(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects invalid ids before loading the request', async () => {
    const result = await requestProposalAsAdmin({ requestId: 'nope', relationshipId: 'also-nope' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });

  it('rejects when the request is gone', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    const result = await requestProposalAsAdmin(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'This request can no longer take a proposal request.',
    });
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it('rejects when the relationship is not on the request (IDOR-safe)', async () => {
    const result = await requestProposalAsAdmin({
      requestId: REQUEST_ID,
      relationshipId: OTHER_RELATIONSHIP_ID,
    });
    expect(result).toEqual({ success: false, error: 'This expert is not on this request.' });
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it.each(['proposal_requested', 'proposal_submitted', 'accepted'])(
    'pre-check: relationship already %s → already_requested',
    async (relationshipStatus) => {
      mockFindByIdWithRelations.mockResolvedValue(buildRequest({ relationshipStatus }));
      const result = await requestProposalAsAdmin(VALID_INPUT);
      expect(result).toEqual({
        success: false,
        error: 'A proposal has already been requested from this expert.',
        code: 'already_requested',
      });
      expect(mockTransition).not.toHaveBeenCalled();
    }
  );

  it('pre-check: declined relationship → no-longer-available copy', async () => {
    mockFindByIdWithRelations.mockResolvedValue(buildRequest({ relationshipStatus: 'declined' }));
    const result = await requestProposalAsAdmin(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You can no longer request a proposal from this expert.',
    });
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it('happy path (invited): transitions WITHOUT expectedFrom and returns analytics + requestTransition', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      buildRequest({
        relationshipStatus: 'invited',
        requestStatus: 'experts_invited',
        eoiSubmittedAt: new Date(Date.now() - 90_000),
      })
    );

    const result = await requestProposalAsAdmin(VALID_INPUT);

    // Admin full bypass — NO expectedFrom (a deep-equal match excludes it).
    expect(mockTransition).toHaveBeenCalledWith({ id: RELATIONSHIP_ID, to: 'proposal_requested' });
    expect(mockFindById).toHaveBeenCalledWith(REQUEST_ID);
    expect(mockCountThreadActivity).toHaveBeenCalledWith(RELATIONSHIP_ID);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.expertProfileId).toBe(EXPERT_PROFILE_ID);
      expect(result.transitioned).toBe(true);
      expect(result.requestTransition).toEqual({
        from: 'experts_invited',
        to: 'proposal_requested',
      });
      expect(result.analytics.proposalRequestCount).toBe(1);
      expect(result.analytics.timeFromFirstEoiMs).toBeGreaterThanOrEqual(0);
      expect(result.analytics.messageCount).toBe(4);
      expect(result.analytics.fileCount).toBe(1);
    }
    expect(log.info).toHaveBeenCalledWith(
      'Admin requested proposal',
      expect.objectContaining({ requestId: REQUEST_ID, adminUserId: 'admin-1', transitioned: true })
    );
  });

  it('happy path (eoi_submitted): also transitions without expectedFrom', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      buildRequest({ relationshipStatus: 'eoi_submitted', requestStatus: 'eoi_submitted' })
    );
    const result = await requestProposalAsAdmin(VALID_INPUT);
    expect(mockTransition).toHaveBeenCalledWith({ id: RELATIONSHIP_ID, to: 'proposal_requested' });
    expect(result.success).toBe(true);
  });

  it('publishes project.proposal_requested with initiatedBy:admin and recipientId = createdByUserId', async () => {
    await requestProposalAsAdmin(VALID_INPUT);
    expect(mockPublish).toHaveBeenCalledWith('project.proposal_requested', {
      correlationId: RELATIONSHIP_ID,
      projectRequestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'CPQ implementation',
      initiatedBy: 'admin',
      recipientId: CREATED_BY_USER_ID,
    });
  });

  it('counts existing proposal-phase relationships into proposal_request_count (incl. this one)', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      buildRequest({
        relationshipStatus: 'invited',
        eoiSubmittedAt: new Date(Date.now() - 120_000),
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
    const result = await requestProposalAsAdmin(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.analytics.proposalRequestCount).toBe(2);
      // The OTHER relationship's older EOI is the request's first EOI.
      expect(result.analytics.timeFromFirstEoiMs).toBeGreaterThanOrEqual(600_000);
    }
  });

  it('transitioned:false + null requestTransition when the request rollup does not advance', async () => {
    // Another thread already advanced the request to proposal_requested.
    mockFindByIdWithRelations.mockResolvedValue(
      buildRequest({ relationshipStatus: 'invited', requestStatus: 'proposal_requested' })
    );
    mockFindById.mockResolvedValue({ id: REQUEST_ID, status: 'proposal_requested' });
    const result = await requestProposalAsAdmin(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.transitioned).toBe(false);
      expect(result.requestTransition).toBeNull();
    }
  });

  it('returns null timeFromFirstEoiMs when no live EOI resolves', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      buildRequest({ relationshipStatus: 'invited', eoiSubmittedAt: null })
    );
    const result = await requestProposalAsAdmin(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.analytics.timeFromFirstEoiMs).toBeNull();
  });

  it('concurrent race (InvalidRelationshipTransitionError) → already_requested, no re-read, no publish', async () => {
    mockTransition.mockRejectedValue(
      new InvalidRelationshipTransitionError('proposal_requested', 'proposal_requested')
    );
    const result = await requestProposalAsAdmin(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'A proposal has already been requested from this expert.',
      code: 'already_requested',
    });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('a rejected notification publish never fails the commit', async () => {
    mockPublish.mockRejectedValue(new Error('queue down'));
    const result = await requestProposalAsAdmin(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it('revalidates the request path on success', async () => {
    await requestProposalAsAdmin(VALID_INPUT);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('maps unexpected failures to the generic copy and logs the original error', async () => {
    mockTransition.mockRejectedValue(new Error('DB down'));
    const result = await requestProposalAsAdmin(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not request the proposal. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to request proposal as admin',
      expect.objectContaining({ error: 'DB down', adminUserId: 'admin-1' })
    );
  });
});
