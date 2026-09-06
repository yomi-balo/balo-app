import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000004';

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
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...a: unknown[]) => mockFindByIdWithRelations(...a),
  },
  requestExpertRelationshipsRepository: {
    declineTrack: (...a: unknown[]) => mockDeclineTrack(...a),
  },
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

import { declineTrackAsAdminAction } from './decline-track-as-admin';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: RELATIONSHIP_ID };

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    companyId: 'company-1',
    title: 'CPQ implementation',
    createdByUserId: 'owner-1',
    company: { id: 'company-1', name: 'Acme Corp' },
    relationships: [{ id: RELATIONSHIP_ID, expertProfileId: EXPERT_PROFILE_ID, status: 'invited' }],
    ...overrides,
  };
}

function declineResult(overrides: Record<string, unknown> = {}) {
  return {
    relationship: { id: RELATIONSHIP_ID, expertProfileId: EXPERT_PROFILE_ID, status: 'declined' },
    previousStatus: 'eoi_submitted',
    declineAuditId: 'decline-audit-1',
    declinedProposalIds: [],
    hadOpenProposal: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetScheduled();
  mockPublish.mockResolvedValue(undefined);
  mockRequireOnboardedUser.mockResolvedValue(ADMIN);
  mockFindByIdWithRelations.mockResolvedValue(requestRow());
  mockDeclineTrack.mockResolvedValue(declineResult());
});

describe('declineTrackAsAdminAction', () => {
  it('rejects an unauthenticated caller', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await declineTrackAsAdminAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockDeclineTrack).not.toHaveBeenCalled();
  });

  it('denies a plain user (no platform capability) before touching the repo', async () => {
    mockRequireOnboardedUser.mockResolvedValue({ id: 'u-2', platformRole: 'user' });
    const result = await declineTrackAsAdminAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
    expect(mockDeclineTrack).not.toHaveBeenCalled();
  });

  it('returns a gone message when the request no longer exists', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    const result = await declineTrackAsAdminAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'This request no longer exists.',
      code: 'gone',
    });
    expect(mockDeclineTrack).not.toHaveBeenCalled();
  });

  it('IDOR guard: refuses a relationshipId that is not on this request', async () => {
    const result = await declineTrackAsAdminAction({
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

  it('declines with reason balo_declined', async () => {
    await declineTrackAsAdminAction(VALID_INPUT);
    expect(mockDeclineTrack).toHaveBeenCalledWith({
      relationshipId: RELATIONSHIP_ID,
      actorUserId: ADMIN.id,
      reason: 'balo_declined',
    });
  });

  it('maps InvalidRelationshipTransitionError to a friendly not_declinable code', async () => {
    mockDeclineTrack.mockRejectedValue(
      new InvalidRelationshipTransitionError('accepted', 'declined')
    );
    const result = await declineTrackAsAdminAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'This track can no longer be declined.',
      code: 'not_declinable',
    });
  });

  // ── The publish is DEFERRED, not fire-and-forget (Qodo #12) ────────────────────
  // Identical reasoning to the client arm: an un-awaited promise is at-most-once on Vercel,
  // and the decline has already committed, so a dropped publish is never retried.

  it('REGISTERS the publish with runAfterResponse and does not run it inline', async () => {
    await declineTrackAsAdminAction(VALID_INPUT);

    expect(runAfterResponseMock).toHaveBeenCalledWith(
      'track decline fan-out',
      expect.any(Function)
    );
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes project.track_declined with declinedBy: balo', async () => {
    await declineTrackAsAdminAction(VALID_INPUT);
    await getScheduled()?.();
    expect(mockPublish).toHaveBeenCalledWith('project.track_declined', {
      correlationId: 'decline-audit-1',
      projectRequestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'CPQ implementation',
      clientCompanyName: 'Acme Corp',
      declinedBy: 'balo',
      stage: 'eoi_submitted',
      hadOpenProposal: false,
    });
  });

  it('revalidates the request-detail path', async () => {
    await declineTrackAsAdminAction(VALID_INPUT);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('returns server-computed analytics with actorKind: balo', async () => {
    const result = await declineTrackAsAdminAction(VALID_INPUT);
    expect(result).toEqual({
      success: true,
      analytics: { stage: 'eoi_submitted', actorKind: 'balo', hadOpenProposal: false },
    });
  });

  it('maps a Postgres deadlock (40P01) to retryable copy and a WARN, not an error', async () => {
    mockDeclineTrack.mockRejectedValue(
      Object.assign(new Error('deadlock detected'), { code: '40P01' })
    );
    const result = await declineTrackAsAdminAction(VALID_INPUT);
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
    const result = await declineTrackAsAdminAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not decline this track. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to decline request track as admin',
      expect.objectContaining({ requestId: REQUEST_ID, relationshipId: RELATIONSHIP_ID })
    );
  });
});
