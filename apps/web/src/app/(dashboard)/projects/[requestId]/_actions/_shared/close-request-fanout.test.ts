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

const mockFindUserIdsByProfileIds = vi.fn();
vi.mock('@balo/db', () => ({
  expertsRepository: {
    findUserIdsByProfileIds: (...args: unknown[]) => mockFindUserIdsByProfileIds(...args),
  },
}));

const mockPostCancelledTeardown = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/meetings/cancelled-teardown-api-client', () => ({
  postCancelledTeardown: (...args: unknown[]) => mockPostCancelledTeardown(...args),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
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
  mockFindUserIdsByProfileIds.mockResolvedValue([]);
  mockPostCancelledTeardown.mockResolvedValue(undefined);
  mockPublish.mockResolvedValue(undefined);
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

  it('resolves expert USER ids from declinedTracks and publishes them as recipientUserIds', async () => {
    const result = closeResult({
      declinedTracks: [
        {
          relationshipId: 'rel-1',
          expertProfileId: 'expert-profile-1',
          previousStatus: 'proposal_submitted',
          declineAuditId: 'decline-1',
        },
      ],
    });
    mockFindUserIdsByProfileIds.mockResolvedValue(['user-1']);

    runCloseRequestFanout(result, BASE_CONTEXT);
    await getScheduled()?.();

    expect(mockFindUserIdsByProfileIds).toHaveBeenCalledWith(['expert-profile-1']);
    expect(mockPublish).toHaveBeenCalledWith('project.request_closed', {
      correlationId: 'audit-1',
      projectRequestId: 'request-1',
      title: 'CPQ implementation',
      clientCompanyName: 'Acme Corp',
      closedBy: 'client',
      reason: 'withdrawn',
      recipientUserIds: ['user-1'],
    });
  });

  it('never sets recipientId on the client-closed arm', async () => {
    mockFindUserIdsByProfileIds.mockResolvedValue(['user-1']);
    runCloseRequestFanout(
      closeResult({
        declinedTracks: [
          {
            relationshipId: 'rel-1',
            expertProfileId: 'expert-profile-1',
            previousStatus: 'invited',
            declineAuditId: 'decline-1',
          },
        ],
      }),
      BASE_CONTEXT
    );
    await getScheduled()?.();

    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.recipientId).toBeUndefined();
  });

  it('sets recipientId when Balo closed it, even with zero live tracks', async () => {
    mockFindUserIdsByProfileIds.mockResolvedValue([]);
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
    mockFindUserIdsByProfileIds.mockResolvedValue([]);
    runCloseRequestFanout(closeResult(), BASE_CONTEXT);
    await getScheduled()?.();

    expect(mockPublish).not.toHaveBeenCalled();
    // The teardown call still happens even when the publish is skipped.
    expect(mockPostCancelledTeardown).toHaveBeenCalledWith([]);
  });
});
