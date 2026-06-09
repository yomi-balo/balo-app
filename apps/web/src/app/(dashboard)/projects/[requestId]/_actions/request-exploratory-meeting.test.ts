import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const mockRequireAdmin = vi.fn();
vi.mock('@/lib/auth/require-admin', () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { requestExploratoryMeetingAction } from './request-exploratory-meeting';
import { revalidatePath } from 'next/cache';

describe('requestExploratoryMeetingAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ id: 'admin-1', platformRole: 'admin' });
    mockTransitionStatus.mockResolvedValue({
      id: REQUEST_ID,
      createdByUserId: 'user-client',
      title: 'CPQ implementation',
      createdAt: new Date(Date.now() - 60_000),
      status: 'exploratory_meeting_requested',
    });
  });

  it('rejects a non-admin', async () => {
    mockRequireAdmin.mockRejectedValue(new Error('Forbidden'));
    const result = await requestExploratoryMeetingAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
    expect(mockTransitionStatus).not.toHaveBeenCalled();
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
