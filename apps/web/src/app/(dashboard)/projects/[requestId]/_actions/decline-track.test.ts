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

const mockPublishNow = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEventNow: (...a: unknown[]) => mockPublishNow(...a),
}));

const { runAfterResponseMock, getScheduled, resetScheduled } = vi.hoisted(() => {
  let scheduled: (() => Promise<void>) | null = null;
  return {
    runAfterResponseMock: vi.fn((_label: string, work: () => Promise<void>) => {
      scheduled = work;
    }),
    getScheduled: (): (() => Promise<void>) | null => scheduled,
    resetScheduled: (): void => {
      scheduled = null;
    },
  };
});

vi.mock('@/lib/after-response', () => ({
  runAfterResponse: runAfterResponseMock,
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
  resetScheduled();
  mockPublishNow.mockResolvedValue(undefined);
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

  // ── The publish is DEFERRED, not fire-and-forget (Qodo #12) ────────────────────
  // A bare un-awaited promise is at-most-once on Vercel: the action returns, the instance
  // freezes, and the expert is never told — with the decline already committed. THIS is the
  // regression the assertions below exist to prevent.
  //
  // Qodo round 3: the action's own `runAfterResponse` is now the ONLY deferral — inside it
  // sits the awaitable `publishNotificationEventNow`, which POSTs rather than registering a
  // second `after()` callback. The pin is unchanged in force: nothing hits the wire on the
  // response path, and the deferred callback really does publish when run.

  it('REGISTERS the publish with runAfterResponse and does not run it inline', async () => {
    await declineTrackAction(VALID_INPUT);

    expect(runAfterResponseMock).toHaveBeenCalledWith(
      'track decline fan-out',
      expect.any(Function)
    );
    expect(mockPublishNow).not.toHaveBeenCalled();
  });

  it('publishes project.track_declined with the audit id as correlationId', async () => {
    await declineTrackAction(VALID_INPUT);
    await getScheduled()?.();
    expect(mockPublishNow).toHaveBeenCalledWith('project.track_declined', {
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

  it('maps a Postgres deadlock (40P01) to retryable copy and a WARN, not an error', async () => {
    mockDeclineTrack.mockRejectedValue(
      Object.assign(new Error('deadlock detected'), { code: '40P01' })
    );
    const result = await declineTrackAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Something ran at the same moment — please try again.',
    });
    expect(log.warn).toHaveBeenCalledWith(
      'Request track decline aborted by a Postgres deadlock (40P01) — retryable',
      expect.objectContaining({ requestId: REQUEST_ID, relationshipId: RELATIONSHIP_ID })
    );
    expect(log.error).not.toHaveBeenCalled();
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
