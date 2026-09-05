import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000004';
const COMPANY_ID = 'company-1';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

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
const mockDeclineTrack = vi.fn();
const mockGetMemberRole = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...a: unknown[]) => mockFindByIdWithRelations(...a),
  },
  requestExpertRelationshipsRepository: {
    declineTrack: (...a: unknown[]) => mockDeclineTrack(...a),
  },
  partyMembershipsRepository: { getMemberRole: (...a: unknown[]) => mockGetMemberRole(...a) },
  InvalidRelationshipTransitionError,
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublish(...a),
}));

import { declineTrackAction } from './decline-track';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const CLIENT_USER = { id: 'user-1', companyId: COMPANY_ID, platformRole: 'user' };
const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: RELATIONSHIP_ID };

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    companyId: COMPANY_ID,
    title: 'CPQ implementation',
    createdByUserId: 'owner-1',
    company: { id: COMPANY_ID, name: 'Acme Corp' },
    relationships: [{ id: RELATIONSHIP_ID, expertProfileId: EXPERT_PROFILE_ID, status: 'invited' }],
    ...overrides,
  };
}

function declineResult(overrides: Record<string, unknown> = {}) {
  return {
    relationship: { id: RELATIONSHIP_ID, expertProfileId: EXPERT_PROFILE_ID, status: 'declined' },
    previousStatus: 'proposal_submitted',
    declineAuditId: 'decline-audit-1',
    declinedProposalIds: [],
    hadOpenProposal: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(CLIENT_USER);
  mockFindByIdWithRelations.mockResolvedValue(requestRow());
  mockGetMemberRole.mockResolvedValue('member');
  mockDeclineTrack.mockResolvedValue(declineResult());
});

describe('declineTrackAction', () => {
  it('rejects an unauthenticated caller', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await declineTrackAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockDeclineTrack).not.toHaveBeenCalled();
  });

  it('a missing request is BYTE-IDENTICAL to a permission denial (no existence oracle)', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    const missing = await declineTrackAction(VALID_INPUT);
    expect(missing).toEqual({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
    expect(mockDeclineTrack).not.toHaveBeenCalled();

    // The read succeeds but the caller holds nothing: the SAME literal, so the wire cannot be
    // used to learn whether a request UUID still exists.
    mockFindByIdWithRelations.mockResolvedValue(requestRow());
    mockGetMemberRole.mockResolvedValue(undefined);
    expect(await declineTrackAction(VALID_INPUT)).toEqual(missing);
    expect(mockDeclineTrack).not.toHaveBeenCalled();
  });

  it('denies a caller with no membership on the request company', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    const result = await declineTrackAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
    expect(mockDeclineTrack).not.toHaveBeenCalled();
  });

  it('IDOR guard: refuses a relationshipId that is not on this request', async () => {
    const result = await declineTrackAction({
      requestId: REQUEST_ID,
      relationshipId: OTHER_RELATIONSHIP_ID,
    });
    expect(result).toEqual({
      success: false,
      error: 'This track can no longer be declined.',
      code: 'not_declinable',
    });
    expect(mockDeclineTrack).not.toHaveBeenCalled();
  });

  it('declines with reason client_declined', async () => {
    await declineTrackAction(VALID_INPUT);
    expect(mockDeclineTrack).toHaveBeenCalledWith({
      relationshipId: RELATIONSHIP_ID,
      actorUserId: CLIENT_USER.id,
      reason: 'client_declined',
    });
  });

  it('maps InvalidRelationshipTransitionError to a friendly not_declinable code', async () => {
    mockDeclineTrack.mockRejectedValue(
      new InvalidRelationshipTransitionError('accepted', 'declined')
    );
    const result = await declineTrackAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'This track can no longer be declined.',
      code: 'not_declinable',
    });
  });

  it('publishes project.track_declined with the audit id as correlationId', async () => {
    await declineTrackAction(VALID_INPUT);
    expect(mockPublish).toHaveBeenCalledWith('project.track_declined', {
      correlationId: 'decline-audit-1',
      projectRequestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'CPQ implementation',
      clientCompanyName: 'Acme Corp',
      declinedBy: 'client',
      stage: 'proposal_submitted',
      hadOpenProposal: false,
    });
  });

  it('revalidates the request-detail path', async () => {
    await declineTrackAction(VALID_INPUT);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('returns server-computed analytics from the decline result', async () => {
    mockDeclineTrack.mockResolvedValue(
      declineResult({ previousStatus: 'invited', hadOpenProposal: false })
    );
    const result = await declineTrackAction(VALID_INPUT);
    expect(result).toEqual({
      success: true,
      analytics: { stage: 'invited', actorKind: 'client', hadOpenProposal: false },
    });
  });

  it('a generic thrown error is logged and returns a generic failure', async () => {
    mockDeclineTrack.mockRejectedValue(new Error('db exploded'));
    const result = await declineTrackAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not decline this track. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to decline request track',
      expect.objectContaining({ requestId: REQUEST_ID, relationshipId: RELATIONSHIP_ID })
    );
  });
});
