import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformCapability } from '@balo/shared/authz';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const EXPERT_A = 'b0000000-0000-4000-8000-00000000000a';
const EXPERT_B = 'b0000000-0000-4000-8000-00000000000b';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindById = vi.fn();
const mockTransitionStatus = vi.fn();
const mockInvite = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
    transitionStatus: (...args: unknown[]) => mockTransitionStatus(...args),
  },
  requestExpertRelationshipsRepository: {
    invite: (...args: unknown[]) => mockInvite(...args),
  },
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

/**
 * BAL-558 — the LIVE-ROW platform gate `requireRequestStaffCapability` runs after its
 * synchronous session check. Mocked to GRANT by default, so every pre-existing case below still
 * exercises exactly what it did before: the session gate is still what decides them.
 */
const mockActorHoldsLive = vi.fn<
  (userId: string, capability: PlatformCapability) => Promise<boolean>
>(async () => true);
vi.mock('@/lib/authz/live-platform-capability', () => ({
  actorHoldsPlatformCapability: (userId: string, capability: PlatformCapability) =>
    mockActorHoldsLive(userId, capability),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { inviteExpertsAction } from './invite-experts';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' as const };
const PERMISSION_DENIED = 'You do not have permission to do this.';

function requestRow(status: string) {
  return {
    id: REQUEST_ID,
    status,
    title: 'CPQ implementation',
    createdAt: new Date(Date.now() - 60_000),
  };
}

describe('inviteExpertsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    mockActorHoldsLive.mockImplementation(async () => true);
    mockFindById.mockResolvedValue(requestRow('requested'));
    mockTransitionStatus.mockResolvedValue(undefined);
    let n = 0;
    mockInvite.mockImplementation((input: { expertProfileId: string }) => {
      n += 1;
      return Promise.resolve({ id: `rel-${n}`, expertProfileId: input.expertProfileId });
    });
  });

  it('denies an unauthenticated caller; no repo/publish/revalidate call', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockInvite).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('denies a session-uncapable caller (platformRole "user"); live gate NOT called', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
    expect(mockInvite).not.toHaveBeenCalled();
  });

  it('BAL-560/BAL-558: denies when the LIVE row has revoked the capability, though the cookie still grants', async () => {
    mockActorHoldsLive.mockResolvedValueOnce(false);
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockInvite).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(mockActorHoldsLive).toHaveBeenCalledWith(ADMIN.id, 'manage_any_request_sourcing');
  });

  it('ordering: an uncapable caller with INVALID input gets the permission denial, not the validation message', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
    const result = await inviteExpertsAction({ requestId: REQUEST_ID, expertProfileIds: [] });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
  });

  it('a thrown session read resolves to the permission denial, not an unhandled rejection', async () => {
    mockGetCurrentUser.mockRejectedValueOnce(new Error('bad seal'));
    await expect(
      inviteExpertsAction({ requestId: REQUEST_ID, expertProfileIds: [EXPERT_A] })
    ).resolves.toEqual({ success: false, error: PERMISSION_DENIED });
  });

  it('rejects empty / invalid input', async () => {
    const result = await inviteExpertsAction({ requestId: REQUEST_ID, expertProfileIds: [] });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
  });

  it('rejects when the request is gone', async () => {
    mockFindById.mockResolvedValue(undefined);
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(result).toEqual({ success: false, error: 'This request no longer exists.' });
  });

  it('rejects inviting once the window has closed (proposal_requested)', async () => {
    mockFindById.mockResolvedValue(requestRow('proposal_requested'));
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(result).toEqual({
      success: false,
      error: 'Experts can no longer be invited to this request.',
    });
    expect(mockInvite).not.toHaveBeenCalled();
  });

  it('invites each expert and publishes project.expert_invited per invite', async () => {
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A, EXPERT_B],
    });
    expect(mockInvite).toHaveBeenCalledTimes(2);
    expect(mockInvite).toHaveBeenCalledWith({
      projectRequestId: REQUEST_ID,
      expertProfileId: EXPERT_A,
      invitedByUserId: 'admin-1',
    });
    expect(mockPublish).toHaveBeenCalledWith('project.expert_invited', {
      correlationId: 'rel-1',
      projectRequestId: REQUEST_ID,
      expertProfileId: EXPERT_A,
      title: 'CPQ implementation',
    });
    expect(result.success && result.invitedCount).toBe(2);
  });

  it('transitions the request once (requested → experts_invited) on first invite', async () => {
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(mockTransitionStatus).toHaveBeenCalledTimes(1);
    expect(mockTransitionStatus).toHaveBeenCalledWith({
      id: REQUEST_ID,
      to: 'experts_invited',
      expectedFrom: 'requested',
    });
    expect(result.success && result.transitioned).toBe(true);
    if (result.success) {
      expect(result.from).toBe('requested');
      expect(result.firstAdminActionMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('transitions from exploratory_meeting_requested too', async () => {
    mockFindById.mockResolvedValue(requestRow('exploratory_meeting_requested'));
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(mockTransitionStatus).toHaveBeenCalledWith({
      id: REQUEST_ID,
      to: 'experts_invited',
      expectedFrom: 'exploratory_meeting_requested',
    });
    if (result.success) {
      expect(result.from).toBe('exploratory_meeting_requested');
      // firstAdminActionMs is only computed for the requested → ... move.
      expect(result.firstAdminActionMs).toBeUndefined();
    }
  });

  it('does NOT transition on the invite-another path (already experts_invited)', async () => {
    mockFindById.mockResolvedValue(requestRow('experts_invited'));
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(result.success && result.transitioned).toBe(false);
  });

  it('skips a live-duplicate invite (invite() → undefined) without aborting the batch', async () => {
    // A live duplicate now resolves to `undefined` (ON CONFLICT DO NOTHING), not a throw.
    mockInvite
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 'rel-2', expertProfileId: EXPERT_B });
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A, EXPERT_B],
    });
    expect(result.success && result.invitedCount).toBe(1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockTransitionStatus).toHaveBeenCalledTimes(1);
  });

  it('returns invitedCount 0 with no transition when all are live dups', async () => {
    mockInvite.mockResolvedValue(undefined);
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A, EXPERT_B],
    });
    expect(result).toMatchObject({ success: true, invitedCount: 0, transitioned: false });
    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('surfaces a real invite failure instead of masking it as a dup-skip', async () => {
    // A genuine error (FK / connection) must NOT be swallowed as a duplicate.
    mockInvite
      .mockResolvedValueOnce({ id: 'rel-1', expertProfileId: EXPERT_A })
      .mockRejectedValueOnce(new Error('connection reset'));
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A, EXPERT_B],
    });
    expect(result).toEqual({
      success: false,
      error: 'Could not invite experts. Please try again.',
    });
    // A failed batch performs no request-level transition.
    expect(mockTransitionStatus).not.toHaveBeenCalled();
  });

  // fix round R1 — `requestExpertRelationshipsRepository.invite` is one of the eleven writers
  // serialised on the per-request advisory lock (`_shared/request-lock.ts`) — the racer named
  // in `close()`'s own KNOWN RESIDUAL block.
  it('maps a Postgres lock timeout (55P03) to retryable copy and a WARN, not an error', async () => {
    mockInvite.mockRejectedValue(
      Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
    );
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(result).toEqual({
      success: false,
      error: 'Something ran at the same moment — please try again.',
    });
    expect(log.warn).toHaveBeenCalledWith(
      'Expert invite aborted by lock contention — retryable',
      expect.objectContaining({ requestId: REQUEST_ID, adminUserId: 'admin-1' })
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('returns a generic error on an unexpected failure', async () => {
    mockFindById.mockRejectedValue(new Error('DB down'));
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(result).toEqual({
      success: false,
      error: 'Could not invite experts. Please try again.',
    });
  });
});
