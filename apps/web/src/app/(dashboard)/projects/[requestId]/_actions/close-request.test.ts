import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const COMPANY_ID = 'company-1';

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
// The authz seam is REAL (pure `@balo/shared/authz` map via a mocked membership read) so the
// capability gate is exercised end-to-end; only `partyMembershipsRepository.getMemberRole` is
// controlled.
const mockGetMemberRole = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...a: unknown[]) => mockFindByIdWithRelations(...a),
    close: (...a: unknown[]) => mockClose(...a),
  },
  partyMembershipsRepository: { getMemberRole: (...a: unknown[]) => mockGetMemberRole(...a) },
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

import { closeRequestAction } from './close-request';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const USER = { id: 'user-1', companyId: COMPANY_ID, platformRole: 'user' };
const VALID_INPUT = { requestId: REQUEST_ID };

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    companyId: COMPANY_ID,
    title: 'CPQ implementation',
    createdByUserId: 'owner-1',
    company: { id: COMPANY_ID, name: 'Acme Corp' },
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
    withdrawnProposalIds: [],
    cancelledMeetings: [],
    revokedRepresentationIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(USER);
  mockFindByIdWithRelations.mockResolvedValue(requestRow());
  mockGetMemberRole.mockResolvedValue('member');
  mockClose.mockResolvedValue(closeResult());
});

describe('closeRequestAction', () => {
  it('rejects an unauthenticated caller', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await closeRequestAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid requestId', async () => {
    const result = await closeRequestAction({ requestId: 'nope' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });

  it('a missing request is BYTE-IDENTICAL to a permission denial (no existence oracle)', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    const missing = await closeRequestAction(VALID_INPUT);
    expect(missing).toEqual({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
    expect(mockClose).not.toHaveBeenCalled();

    // The read succeeds but the caller holds nothing: the SAME literal, so the wire cannot be
    // used to learn whether a request UUID still exists.
    mockFindByIdWithRelations.mockResolvedValue(requestRow());
    mockGetMemberRole.mockResolvedValue(undefined);
    expect(await closeRequestAction(VALID_INPUT)).toEqual(missing);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('denies a caller with no membership on the request company', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    const result = await closeRequestAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('a base member (no elevated role) can close — MANAGE_REQUESTS is a base capability', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    const result = await closeRequestAction(VALID_INPUT);
    expect(result.success).toBe(true);
    expect(mockClose).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      actorUserId: USER.id,
      actorKind: 'client',
      reason: 'withdrawn',
      note: null,
    });
  });

  it('never accepts a reason or note on the wire — the schema is .strict()', async () => {
    // @ts-expect-error — deliberately passing extra fields to prove they are rejected.
    const result = await closeRequestAction({ ...VALID_INPUT, reason: 'declined', note: 'x' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
  });

  it('maps InvalidStatusTransitionError to a friendly not_closable code', async () => {
    mockClose.mockRejectedValue(new InvalidStatusTransitionError('accepted', 'closed'));
    const result = await closeRequestAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'This request can no longer be closed.',
      code: 'not_closable',
    });
  });

  it('logs the closure WITHOUT the note field and never logs a note value', async () => {
    await closeRequestAction(VALID_INPUT);
    expect(log.info).toHaveBeenCalledWith(
      'Project request closed',
      expect.objectContaining({
        requestId: REQUEST_ID,
        actorUserId: USER.id,
        actorKind: 'client',
        reason: 'withdrawn',
      })
    );
    const [, fields] = (log.info as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(fields).not.toHaveProperty('note');
  });

  it('runs the post-commit fan-out with closedBy: client and no recipientId context field set', async () => {
    const result = closeResult({
      declinedTracks: [
        {
          relationshipId: 'rel-1',
          expertProfileId: 'expert-1',
          previousStatus: 'proposal_submitted',
          declineAuditId: 'decline-1',
        },
      ],
    });
    mockClose.mockResolvedValue(result);

    await closeRequestAction(VALID_INPUT);

    expect(mockRunCloseRequestFanout).toHaveBeenCalledWith(result, {
      title: 'CPQ implementation',
      clientCompanyName: 'Acme Corp',
      createdByUserId: 'owner-1',
      closedBy: 'client',
      reason: 'withdrawn',
    });
  });

  it('revalidates both the detail and inbox paths', async () => {
    await closeRequestAction(VALID_INPUT);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith('/projects');
  });

  it('returns server-computed analytics from the close result', async () => {
    mockClose.mockResolvedValue(
      closeResult({
        previousStatus: 'eoi_submitted',
        declinedTracks: [
          {
            relationshipId: 'rel-1',
            expertProfileId: 'expert-1',
            previousStatus: 'eoi_submitted',
            declineAuditId: 'decline-1',
          },
        ],
        withdrawnProposalIds: ['prop-1'],
      })
    );

    const result = await closeRequestAction(VALID_INPUT);
    expect(result).toEqual({
      success: true,
      analytics: {
        reason: 'withdrawn',
        actorKind: 'client',
        stageAtClose: 'eoi_submitted',
        openTracks: 1,
        openProposals: 1,
        expertsTold: 1,
      },
    });
  });

  it('a generic thrown error is logged and returns a generic failure', async () => {
    mockClose.mockRejectedValue(new Error('db exploded'));
    const result = await closeRequestAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not close the request. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to close project request',
      expect.objectContaining({ requestId: REQUEST_ID, error: 'db exploded' })
    );
  });
});
