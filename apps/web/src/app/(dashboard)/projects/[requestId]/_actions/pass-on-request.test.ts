import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000004';
const OTHER_EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000005';
const OWNER_ID = 'd0000000-0000-4000-8000-000000000006';

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
const mockPassTrack = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...a: unknown[]) => mockFindByIdWithRelations(...a),
  },
  requestExpertRelationshipsRepository: {
    passTrack: (...a: unknown[]) => mockPassTrack(...a),
  },
  InvalidRelationshipTransitionError,
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockResolveApprovedExpert = vi.fn();
vi.mock('@/lib/auth/approved-expert', () => ({
  resolveApprovedExpert: (...a: unknown[]) => mockResolveApprovedExpert(...a),
}));

const mockTrackServerAndFlush = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  PROJECT_SERVER_EVENTS: { PROJECT_TRACK_PASSED: 'project_track_passed' },
  trackServerAndFlush: (...a: unknown[]) => mockTrackServerAndFlush(...a),
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
vi.mock('@/lib/after-response', () => ({ runAfterResponse: runAfterResponseMock }));

import { passOnRequestAction } from './pass-on-request';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const EXPERT_USER = { id: 'user-expert', expertProfileId: EXPERT_PROFILE_ID };
const VALID_INPUT = { requestId: REQUEST_ID };
const DENIED = {
  success: false,
  error: 'You do not have permission to do this.',
  code: 'denied',
};

function ownRelationship(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RELATIONSHIP_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    status: 'eoi_submitted',
    expertProfile: { user: { firstName: 'Priya', lastName: 'Nair' } },
    ...overrides,
  };
}

function requestRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    title: 'CPQ implementation',
    createdByUserId: 'creator-1',
    baloOwnerUserId: OWNER_ID,
    company: { id: 'company-1', name: 'Acme Corp' },
    relationships: [ownRelationship()],
    ...overrides,
  };
}

function passResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    relationship: { id: RELATIONSHIP_ID, expertProfileId: EXPERT_PROFILE_ID, status: 'declined' },
    previousStatus: 'eoi_submitted',
    auditId: 'audit-1',
    withdrawnProposalIds: ['p-1'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetScheduled();
  mockPublishNow.mockResolvedValue(undefined);
  mockRequireOnboardedUser.mockResolvedValue(EXPERT_USER);
  mockResolveApprovedExpert.mockResolvedValue({ ok: true, expertProfileId: EXPERT_PROFILE_ID });
  mockFindByIdWithRelations.mockResolvedValue(requestRow());
  mockPassTrack.mockResolvedValue(passResult());
});

describe('passOnRequestAction', () => {
  it('rejects a caller who is not signed in', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await passOnRequestAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockPassTrack).not.toHaveBeenCalled();
  });

  it('rejects invalid input, including an extra relationshipId key', async () => {
    const extra = { ...VALID_INPUT, relationshipId: RELATIONSHIP_ID };
    expect(await passOnRequestAction(extra)).toEqual({ success: false, error: 'Invalid request.' });
    expect(
      await passOnRequestAction({ requestId: 'nope' } as unknown as typeof VALID_INPUT)
    ).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockPassTrack).not.toHaveBeenCalled();
  });

  it('denies when the request does not exist', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    expect(await passOnRequestAction(VALID_INPUT)).toEqual(DENIED);
    expect(mockPassTrack).not.toHaveBeenCalled();
  });

  it('denies when resolveApprovedExpert refuses, identically to a missing request', async () => {
    mockResolveApprovedExpert.mockResolvedValue({ ok: false, reason: 'no_profile' });
    expect(await passOnRequestAction(VALID_INPUT)).toEqual(DENIED);
    expect(mockPassTrack).not.toHaveBeenCalled();
  });

  it('denies when the caller profile has no track on the request at all', async () => {
    mockFindByIdWithRelations.mockResolvedValue(requestRow({ relationships: [] }));
    expect(await passOnRequestAction(VALID_INPUT)).toEqual(DENIED);
    expect(mockPassTrack).not.toHaveBeenCalled();
  });

  it('a stale page (the caller track is already declined) gets not_passable, not a denial', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestRow({ relationships: [ownRelationship({ status: 'declined' })] })
    );
    expect(await passOnRequestAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This project can no longer be passed on.',
      code: 'not_passable',
    });
    expect(mockPassTrack).not.toHaveBeenCalled();
  });

  it("denies when only another expert's track exists", async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestRow({
        relationships: [
          ownRelationship({ id: OTHER_RELATIONSHIP_ID, expertProfileId: OTHER_EXPERT_PROFILE_ID }),
        ],
      })
    );
    expect(await passOnRequestAction(VALID_INPUT)).toEqual(DENIED);
    expect(mockPassTrack).not.toHaveBeenCalled();
  });

  it('refuses a non-passable stage without calling the repository', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestRow({ relationships: [ownRelationship({ status: 'proposal_submitted' })] })
    );
    expect(await passOnRequestAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This project can no longer be passed on.',
      code: 'not_passable',
    });
    expect(mockPassTrack).not.toHaveBeenCalled();
  });

  it("derives the relationship server-side from the caller's own profile", async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestRow({
        relationships: [
          ownRelationship({ id: OTHER_RELATIONSHIP_ID, expertProfileId: OTHER_EXPERT_PROFILE_ID }),
          ownRelationship(),
        ],
      })
    );
    expect(await passOnRequestAction(VALID_INPUT)).toEqual({ success: true });
    expect(mockPassTrack).toHaveBeenCalledWith({
      relationshipId: RELATIONSHIP_ID,
      actorUserId: EXPERT_USER.id,
    });
  });

  it('logs the pass and revalidates the detail page and the inbox', async () => {
    await passOnRequestAction(VALID_INPUT);
    expect(log.info).toHaveBeenCalledWith('Request track passed', {
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      actorUserId: EXPERT_USER.id,
      fromStatus: 'eoi_submitted',
      withdrawnProposalCount: 1,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith('/projects');
  });

  it('tracks project_track_passed with the stage passed from', async () => {
    await passOnRequestAction(VALID_INPUT);
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith('project_track_passed', {
      request_id: REQUEST_ID,
      relationship_id: RELATIONSHIP_ID,
      from_status: 'eoi_submitted',
      distinct_id: EXPERT_USER.id,
    });
  });

  it('registers the publish with runAfterResponse and does not run it inline', async () => {
    await passOnRequestAction(VALID_INPUT);
    expect(runAfterResponseMock).toHaveBeenCalledWith('track pass fan-out', expect.any(Function));
    expect(mockPublishNow).not.toHaveBeenCalled();
  });

  it('publishes project.track_passed with the exact payload', async () => {
    await passOnRequestAction(VALID_INPUT);
    await getScheduled()?.();
    expect(mockPublishNow).toHaveBeenCalledWith('project.track_passed', {
      correlationId: 'audit-1',
      projectRequestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      title: 'CPQ implementation',
      clientCompanyName: 'Acme Corp',
      expertName: 'Priya Nair',
      fromStatus: 'eoi_submitted',
      recipientId: 'creator-1',
      baloOwnerUserId: OWNER_ID,
    });
  });

  it('publishes a null owner and the fallback expert name when neither is known', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestRow({
        baloOwnerUserId: null,
        relationships: [
          ownRelationship({ expertProfile: { user: { firstName: null, lastName: null } } }),
        ],
      })
    );
    await passOnRequestAction(VALID_INPUT);
    await getScheduled()?.();
    expect(mockPublishNow).toHaveBeenCalledWith(
      'project.track_passed',
      expect.objectContaining({ baloOwnerUserId: null, expertName: 'An expert' })
    );
  });

  it('maps InvalidRelationshipTransitionError to not_passable', async () => {
    mockPassTrack.mockRejectedValue(new InvalidRelationshipTransitionError('accepted', 'declined'));
    expect(await passOnRequestAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This project can no longer be passed on.',
      code: 'not_passable',
    });
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    expect(runAfterResponseMock).not.toHaveBeenCalled();
  });

  it('maps lock contention (55P03) to retryable copy and a WARN, not an error', async () => {
    mockPassTrack.mockRejectedValue(Object.assign(new Error('lock timeout'), { code: '55P03' }));
    const result = await passOnRequestAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Something ran at the same moment — please try again.',
    });
    expect(log.warn).toHaveBeenCalledWith(
      'Request track pass aborted by lock contention — retryable',
      expect.objectContaining({ requestId: REQUEST_ID })
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('catches a rejected pre-flight read and returns the generic failure', async () => {
    mockFindByIdWithRelations.mockRejectedValue(new Error('connection reset'));
    expect(await passOnRequestAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Could not pass on this project. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to pass on request track',
      expect.objectContaining({ requestId: REQUEST_ID, error: 'connection reset' })
    );
    expect(mockPassTrack).not.toHaveBeenCalled();
  });

  it('logs a non-Error rejection as a string', async () => {
    mockPassTrack.mockRejectedValue('boom');
    await passOnRequestAction(VALID_INPUT);
    expect(log.error).toHaveBeenCalledWith(
      'Failed to pass on request track',
      expect.objectContaining({ error: 'boom', stack: undefined })
    );
  });
});
