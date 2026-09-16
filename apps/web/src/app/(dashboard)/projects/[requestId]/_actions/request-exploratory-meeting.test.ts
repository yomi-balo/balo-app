import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformCapability } from '@balo/shared/authz';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Real InvalidStatusTransitionError (hoisted) so the action's `instanceof` check
// is exercised even though `vi.mock` factories run before module-body consts.
const { InvalidStatusTransitionError } = vi.hoisted(() => {
  class InvalidStatusTransitionError extends Error {
    constructor(
      public readonly from: string,
      public readonly to: string
    ) {
      super(`Invalid: ${from} → ${to}`);
      this.name = 'InvalidStatusTransitionError';
    }
  }
  return { InvalidStatusTransitionError };
});

const mockTransitionStatus = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    transitionStatus: (...args: unknown[]) => mockTransitionStatus(...args),
  },
  InvalidStatusTransitionError,
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

import { requestExploratoryMeetingAction } from './request-exploratory-meeting';
import { revalidatePath } from 'next/cache';

const ADMIN = { id: 'admin-1', platformRole: 'admin' as const };
const PERMISSION_DENIED = 'You do not have permission to do this.';

describe('requestExploratoryMeetingAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    mockActorHoldsLive.mockImplementation(async () => true);
    mockTransitionStatus.mockResolvedValue({
      id: REQUEST_ID,
      createdByUserId: 'user-client',
      title: 'CPQ implementation',
      createdAt: new Date(Date.now() - 60_000),
      status: 'exploratory_meeting_requested',
    });
  });

  it('denies an unauthenticated caller; no repo/publish/revalidate call', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await requestExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('denies a session-uncapable caller (platformRole "user"); live gate NOT called', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
    const result = await requestExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
    expect(mockTransitionStatus).not.toHaveBeenCalled();
  });

  it('BAL-560/BAL-558: denies when the LIVE row has revoked the capability, though the cookie still grants', async () => {
    mockActorHoldsLive.mockResolvedValueOnce(false);
    const result = await requestExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(mockActorHoldsLive).toHaveBeenCalledWith(ADMIN.id, 'manage_any_request_sourcing');
  });

  it('ordering: an uncapable caller with INVALID input gets the permission denial, not the validation message', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
    const result = await requestExploratoryMeetingAction({ requestId: 'not-a-uuid' });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
  });

  it('a thrown session read resolves to the permission denial, not an unhandled rejection', async () => {
    mockGetCurrentUser.mockRejectedValueOnce(new Error('bad seal'));
    await expect(requestExploratoryMeetingAction({ requestId: REQUEST_ID })).resolves.toEqual({
      success: false,
      error: PERMISSION_DENIED,
    });
  });

  it('rejects an invalid requestId', async () => {
    const result = await requestExploratoryMeetingAction({ requestId: 'not-a-uuid' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockTransitionStatus).not.toHaveBeenCalled();
  });

  it('transitions requested → exploratory_meeting_requested with the concurrency guard', async () => {
    await requestExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(mockTransitionStatus).toHaveBeenCalledWith({
      id: REQUEST_ID,
      to: 'exploratory_meeting_requested',
      expectedFrom: 'requested',
    });
  });

  it('publishes project.exploratory_requested to the client (createdByUserId)', async () => {
    await requestExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(mockPublish).toHaveBeenCalledWith('project.exploratory_requested', {
      correlationId: REQUEST_ID,
      recipientId: 'user-client',
      projectRequestId: REQUEST_ID,
      title: 'CPQ implementation',
    });
  });

  it('revalidates the request path and returns the transition tuple + firstAdminActionMs', async () => {
    const result = await requestExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.from).toBe('requested');
      expect(result.to).toBe('exploratory_meeting_requested');
      expect(result.firstAdminActionMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns a friendly error on an illegal transition', async () => {
    mockTransitionStatus.mockRejectedValue(
      new InvalidStatusTransitionError('experts_invited', 'exploratory_meeting_requested')
    );
    const result = await requestExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(result).toEqual({
      success: false,
      error: 'This request can no longer move to an exploratory call.',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('returns a generic error on an unexpected failure', async () => {
    mockTransitionStatus.mockRejectedValue(new Error('DB down'));
    const result = await requestExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(result).toEqual({
      success: false,
      error: 'Could not request an exploratory call. Please try again.',
    });
  });
});
