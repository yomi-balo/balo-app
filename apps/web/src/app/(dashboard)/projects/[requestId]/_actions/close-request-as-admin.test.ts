import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { InvalidStatusTransitionError } = vi.hoisted(() => {
  class InvalidStatusTransitionError extends Error {
    constructor(
      public readonly from: string,
      public readonly to: string
    ) {
      super(`Invalid transition: ${from} → ${to}`);
      this.name = 'InvalidStatusTransitionError';
    }
  }
  return { InvalidStatusTransitionError };
});

const mockFindByIdWithRelations = vi.fn();
const mockClose = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...a: unknown[]) => mockFindByIdWithRelations(...a),
    close: (...a: unknown[]) => mockClose(...a),
  },
  InvalidStatusTransitionError,
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockRunCloseRequestFanout = vi.fn();
vi.mock('./_shared/close-request-fanout', () => ({
  runCloseRequestFanout: (...a: unknown[]) => mockRunCloseRequestFanout(...a),
}));

import { closeRequestAsAdminAction } from './close-request-as-admin';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const VALID_INPUT = { requestId: REQUEST_ID, reason: 'unfilled' as const, note: 'closed by ops' };

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    companyId: 'company-1',
    title: 'CPQ implementation',
    createdByUserId: 'owner-1',
    company: { id: 'company-1', name: 'Acme Corp' },
    relationships: [],
    ...overrides,
  };
}

function closeResult(overrides: Record<string, unknown> = {}) {
  return {
    request: { id: REQUEST_ID, status: 'closed' },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(ADMIN);
  mockFindByIdWithRelations.mockResolvedValue(requestRow());
  mockClose.mockResolvedValue(closeResult());
});

describe('closeRequestAsAdminAction', () => {
  it('rejects an unauthenticated caller', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await closeRequestAsAdminAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('denies a plain user (no platform capability) before touching the repo', async () => {
    mockRequireOnboardedUser.mockResolvedValue({ id: 'u-2', platformRole: 'user' });
    const result = await closeRequestAsAdminAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it.each(['admin', 'super_admin'])('allows platform role %s', async (platformRole) => {
    mockRequireOnboardedUser.mockResolvedValue({ id: 'staff-1', platformRole });
    const result = await closeRequestAsAdminAction(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it('rejects `withdrawn` as a reason — that is the client-only arm', async () => {
    const result = await closeRequestAsAdminAction({
      ...VALID_INPUT,
      reason: 'withdrawn' as never,
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('rejects a note shorter than 8 characters', async () => {
    const result = await closeRequestAsAdminAction({ ...VALID_INPUT, note: 'short' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('rejects a missing note entirely — REQUIRED on the admin arm', async () => {
    const withoutNote: Record<string, unknown> = { ...VALID_INPUT };
    delete withoutNote.note;
    const result = await closeRequestAsAdminAction(withoutNote as never);
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('returns a gone message when the request no longer exists', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    const result = await closeRequestAsAdminAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'This request no longer exists.',
      code: 'gone',
    });
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('passes actorKind: balo and the note through to the repository', async () => {
    await closeRequestAsAdminAction(VALID_INPUT);
    expect(mockClose).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      actorUserId: ADMIN.id,
      actorKind: 'balo',
      reason: 'unfilled',
      note: 'closed by ops',
    });
  });

  it('maps InvalidStatusTransitionError to a friendly not_closable code', async () => {
    mockClose.mockRejectedValue(new InvalidStatusTransitionError('closed', 'closed'));
    const result = await closeRequestAsAdminAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'This request can no longer be closed.',
      code: 'not_closable',
    });
  });

  it('logs the closure WITHOUT the note field ever appearing in the log payload', async () => {
    await closeRequestAsAdminAction(VALID_INPUT);
    expect(log.info).toHaveBeenCalledWith(
      'Project request closed',
      expect.objectContaining({ requestId: REQUEST_ID, actorKind: 'balo', reason: 'unfilled' })
    );
    const [, fields] = (log.info as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(fields).not.toHaveProperty('note');
    expect(JSON.stringify(fields)).not.toContain('closed by ops');
  });

  it('runs the fan-out with closedBy: balo and the request owner as recipient context', async () => {
    const result = closeResult();
    mockClose.mockResolvedValue(result);

    await closeRequestAsAdminAction(VALID_INPUT);

    expect(mockRunCloseRequestFanout).toHaveBeenCalledWith(result, {
      title: 'CPQ implementation',
      clientCompanyName: 'Acme Corp',
      createdByUserId: 'owner-1',
      closedBy: 'balo',
      reason: 'unfilled',
    });
  });

  it('revalidates both the detail and inbox paths', async () => {
    await closeRequestAsAdminAction(VALID_INPUT);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith('/projects');
  });

  it('reports tracksEnded (not an experts-told count) in the analytics payload', async () => {
    mockClose.mockResolvedValue(
      closeResult({
        declinedTracks: [
          {
            relationshipId: 'rel-1',
            expertProfileId: 'expert-1',
            previousStatus: 'invited',
            declineAuditId: 'decline-1',
          },
        ],
      })
    );
    const result = await closeRequestAsAdminAction(VALID_INPUT);
    expect(result).toEqual({
      success: true,
      analytics: {
        reason: 'unfilled',
        actorKind: 'balo',
        stageAtClose: 'proposal_submitted',
        openTracks: 1,
        openProposals: 0,
        tracksEnded: 1,
      },
    });
  });

  it('maps a Postgres deadlock (40P01) to retryable copy and a WARN, not an error', async () => {
    mockClose.mockRejectedValue(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
    const result = await closeRequestAsAdminAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Something ran at the same moment — please try again.',
    });
    expect(log.warn).toHaveBeenCalledWith(
      'Project request close aborted by a Postgres deadlock (40P01) — retryable',
      expect.objectContaining({ requestId: REQUEST_ID, actorUserId: ADMIN.id })
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('a generic thrown error is logged and returns a generic failure', async () => {
    mockClose.mockRejectedValue(new Error('db exploded'));
    const result = await closeRequestAsAdminAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not close the request. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to close project request as admin',
      expect.objectContaining({ requestId: REQUEST_ID, error: 'db exploded' })
    );
  });
});
