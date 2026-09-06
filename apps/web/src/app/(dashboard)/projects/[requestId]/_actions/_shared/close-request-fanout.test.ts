import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { runAfterResponseMock, getScheduled } = vi.hoisted(() => {
  let scheduled: (() => Promise<void>) | null = null;
  return {
    runAfterResponseMock: vi.fn((_label: string, work: () => Promise<void>) => {
      scheduled = work;
    }),
    getScheduled: (): (() => Promise<void>) | null => scheduled,
  };
});

vi.mock('@/lib/after-response', () => ({
  runAfterResponse: runAfterResponseMock,
}));

/**
 * ⚠ THE REPOSITORY IS MOCKED TO EXPLODE ON CONTACT, DELIBERATELY. The fan-out must perform NO
 * read of its own: `runAfterResponse` never retries and the close has already committed, so a
 * post-commit lookup is a permanent way to lose the expert notices. Re-introducing one turns
 * every publish assertion below red as well as the explicit "never called" pin.
 */
const { mockFindUserIdsByProfileIds } = vi.hoisted(() => ({
  mockFindUserIdsByProfileIds: vi.fn((): string[] => {
    throw new Error('the close fan-out must not read the experts repository post-commit');
  }),
}));
vi.mock('@balo/db', () => ({
  expertsRepository: { findUserIdsByProfileIds: mockFindUserIdsByProfileIds },
}));

/** Call ORDER across the two halves of the deferred callback — the telling must come first. */
const callOrder: string[] = [];

const mockPostCancelledTeardown = vi.fn().mockImplementation(async () => {
  callOrder.push('teardown');
});
vi.mock('@/lib/meetings/cancelled-teardown-api-client', () => ({
  postCancelledTeardown: (...args: unknown[]) => mockPostCancelledTeardown(...args),
}));

const mockPublish = vi.fn().mockImplementation(async () => {
  callOrder.push('publish');
});
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { runCloseRequestFanout } from './close-request-fanout';
import type { CloseRequestResult } from '@balo/db';

function closeResult(overrides: Partial<CloseRequestResult> = {}): CloseRequestResult {
  return {
    request: { id: 'request-1' } as CloseRequestResult['request'],
    previousStatus: 'proposal_submitted',
    closeAuditId: 'audit-1',
    declinedTracks: [],
    declinedTrackUserIds: [],
    withdrawnProposalIds: [],
    cancelledMeetings: [],
    revokedRepresentationIds: [],
    ...overrides,
  };
}

const BASE_CONTEXT = {
  title: 'CPQ implementation',
  clientCompanyName: 'Acme Corp',
  createdByUserId: 'owner-1',
  closedBy: 'client' as const,
  reason: 'withdrawn' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  mockPostCancelledTeardown.mockImplementation(async () => {
    callOrder.push('teardown');
  });
  mockPublish.mockImplementation(async () => {
    callOrder.push('publish');
  });
});

describe('runCloseRequestFanout', () => {
  it('defers all work via runAfterResponse rather than running inline', () => {
    runCloseRequestFanout(closeResult(), BASE_CONTEXT);

    expect(runAfterResponseMock).toHaveBeenCalledWith('close fan-out', expect.any(Function));
    expect(mockPostCancelledTeardown).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('tears down every cancelled meeting, mapped to {meetingId, expertProfileId}', async () => {
    const result = closeResult({
      cancelledMeetings: [
        { meetingId: 'meeting-1', expertProfileId: 'expert-1', cancelAuditId: 'cancel-1' },
        { meetingId: 'meeting-2', expertProfileId: null, cancelAuditId: 'cancel-2' },
      ],
    });
    runCloseRequestFanout(result, BASE_CONTEXT);
    await getScheduled()?.();

    expect(mockPostCancelledTeardown).toHaveBeenCalledWith([
      { meetingId: 'meeting-1', expertProfileId: 'expert-1' },
      { meetingId: 'meeting-2', expertProfileId: null },
    ]);
  });

  // ── The recipients are COMMITTED STATE, not a post-commit lookup (Qodo round 2) ──────

  it('publishes recipientUserIds straight off the result, with NO repository call', async () => {
    const result = closeResult({
      declinedTracks: [
        {
          relationshipId: 'rel-1',
          expertProfileId: 'expert-profile-1',
          previousStatus: 'proposal_submitted',
          declineAuditId: 'decline-1',
        },
      ],
      declinedTrackUserIds: ['user-1', 'user-2'],
    });

    runCloseRequestFanout(result, BASE_CONTEXT);
    await getScheduled()?.();

    expect(mockFindUserIdsByProfileIds).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith('project.request_closed', {
      correlationId: 'audit-1',
      projectRequestId: 'request-1',
      title: 'CPQ implementation',
      clientCompanyName: 'Acme Corp',
      closedBy: 'client',
      reason: 'withdrawn',
      recipientUserIds: ['user-1', 'user-2'],
    });
  });

  it('copies the recipient list rather than aliasing the result array', async () => {
    const result = closeResult({ declinedTrackUserIds: ['user-1'] });
    runCloseRequestFanout(result, BASE_CONTEXT);
    await getScheduled()?.();

    const [, payload] = mockPublish.mock.calls[0] as [string, { recipientUserIds: string[] }];
    expect(payload.recipientUserIds).toEqual(['user-1']);
    expect(payload.recipientUserIds).not.toBe(result.declinedTrackUserIds);
  });

  // ── Ordering: humans before janitorial vendor calls (Qodo round 2) ───────────────────

  it('publishes BEFORE the teardown, so a freeze cannot swallow the telling first', async () => {
    runCloseRequestFanout(
      closeResult({
        declinedTrackUserIds: ['user-1'],
        cancelledMeetings: [
          { meetingId: 'meeting-1', expertProfileId: 'expert-1', cancelAuditId: 'cancel-1' },
        ],
      }),
      BASE_CONTEXT
    );
    await getScheduled()?.();

    expect(callOrder).toEqual(['publish', 'teardown']);
  });

  it('never sets recipientId on the client-closed arm', async () => {
    runCloseRequestFanout(closeResult({ declinedTrackUserIds: ['user-1'] }), BASE_CONTEXT);
    await getScheduled()?.();

    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.recipientId).toBeUndefined();
  });

  it('sets recipientId when Balo closed it, even with zero live tracks', async () => {
    runCloseRequestFanout(closeResult(), { ...BASE_CONTEXT, closedBy: 'balo', reason: 'unfilled' });
    await getScheduled()?.();

    expect(mockPublish).toHaveBeenCalledWith('project.request_closed', {
      correlationId: 'audit-1',
      projectRequestId: 'request-1',
      title: 'CPQ implementation',
      clientCompanyName: 'Acme Corp',
      closedBy: 'balo',
      reason: 'unfilled',
      recipientUserIds: [],
      recipientId: 'owner-1',
    });
  });

  it('skips the publish entirely on a client-closed, zero-track close (nobody to tell)', async () => {
    runCloseRequestFanout(closeResult(), BASE_CONTEXT);
    await getScheduled()?.();

    expect(mockPublish).not.toHaveBeenCalled();
    // ⚠ THE SKIP IS A CONDITION, NOT AN EARLY `return`: the teardown still runs. Turning it
    // back into a `return` above the publish would strand every cancelled Daily room.
    expect(mockPostCancelledTeardown).toHaveBeenCalledWith([]);
  });
});
