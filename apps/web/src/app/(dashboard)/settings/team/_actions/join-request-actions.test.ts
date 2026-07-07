import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────
// @balo/db is mocked (repos + getMemberRole), but @/lib/authz and
// @balo/shared/authz are REAL — so the gate is exercised end-to-end: a member
// role resolves to false, owner/admin to true, through the real capability map.

const {
  mockFindById,
  mockApprove,
  mockDecline,
  mockWithdraw,
  mockGetMemberRole,
  InvalidJoinRequestTransitionError,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockApprove: vi.fn(),
  mockDecline: vi.fn(),
  mockWithdraw: vi.fn(),
  mockGetMemberRole: vi.fn(),
  InvalidJoinRequestTransitionError: class InvalidJoinRequestTransitionError extends Error {},
}));

vi.mock('@balo/db', () => ({
  partyJoinRequestsRepository: {
    findById: mockFindById,
    approve: mockApprove,
    decline: mockDecline,
    withdraw: mockWithdraw,
  },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
  InvalidJoinRequestTransitionError,
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireUser: () => mockRequireUser() }));

const mockPublish = vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublish(...a),
}));

const mockEmitResolved = vi.fn();
vi.mock('@/lib/analytics/party-join', () => ({
  emitJoinRequestResolved: (...a: unknown[]) => mockEmitResolved(...a),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/logging', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { approveJoinRequest } from './approve-join-request';
import { declineJoinRequest } from './decline-join-request';
import { withdrawJoinRequest } from './withdraw-join-request';

// ── Helpers ─────────────────────────────────────────────────────

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN = { id: 'admin-1' };

function companyRequest(over: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    partyType: 'company',
    partyId: 'party-1',
    userId: 'requester-1',
    status: 'pending',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    resolvedAt: null,
    ...over,
  };
}

function resolvedRequest(over: Record<string, unknown> = {}) {
  return companyRequest({
    resolvedAt: new Date('2020-01-01T00:00:10Z'), // 10s after createdAt
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue(ADMIN);
});

// ── approve ─────────────────────────────────────────────────────

describe('approveJoinRequest', () => {
  it('DENIES a base member (no MANAGE_MEMBERS) — no mutation', async () => {
    mockFindById.mockResolvedValue(companyRequest());
    mockGetMemberRole.mockResolvedValue('member');

    const result = await approveJoinRequest({ requestId: REQUEST_ID });

    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('DENIES a non-member (getMemberRole undefined)', async () => {
    mockFindById.mockResolvedValue(companyRequest());
    mockGetMemberRole.mockResolvedValue(undefined);

    const result = await approveJoinRequest({ requestId: REQUEST_ID });
    expect(result.success).toBe(false);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('ALLOWS an owner — approves, notifies requester, tracks resolution', async () => {
    mockFindById.mockResolvedValue(companyRequest());
    mockGetMemberRole.mockResolvedValue('owner');
    mockApprove.mockResolvedValue({
      request: resolvedRequest(),
      membership: { outcome: 'joined' },
    });

    const result = await approveJoinRequest({ requestId: REQUEST_ID });

    expect(result).toEqual({ success: true });
    expect(mockApprove).toHaveBeenCalledWith({ requestId: REQUEST_ID, actorUserId: 'admin-1' });
    expect(mockPublish).toHaveBeenCalledWith('party.join_request_approved', {
      correlationId: REQUEST_ID,
      partyType: 'company',
      partyId: 'party-1',
      userId: 'requester-1',
    });
    expect(mockEmitResolved).toHaveBeenCalledWith('approved', {
      partyType: 'company',
      timeToResolutionSeconds: 10,
      requesterUserId: 'requester-1',
    });
  });

  it('branches the capability scope on the request partyType (agency → agencyId)', async () => {
    mockFindById.mockResolvedValue(companyRequest({ partyType: 'agency', partyId: 'agency-9' }));
    mockGetMemberRole.mockResolvedValue('admin');
    mockApprove.mockResolvedValue({
      request: resolvedRequest({ partyType: 'agency', partyId: 'agency-9' }),
      membership: { outcome: 'joined' },
    });

    await approveJoinRequest({ requestId: REQUEST_ID });

    // hasCapability resolved the role against the AGENCY scope, not a company one.
    expect(mockGetMemberRole).toHaveBeenCalledWith('agency', 'agency-9', 'admin-1');
  });

  it('maps InvalidJoinRequestTransitionError to a friendly message', async () => {
    mockFindById.mockResolvedValue(companyRequest());
    mockGetMemberRole.mockResolvedValue('owner');
    mockApprove.mockRejectedValue(new InvalidJoinRequestTransitionError('nope'));

    const result = await approveJoinRequest({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: 'This request is no longer pending.' });
  });

  it('rejects a non-uuid requestId', async () => {
    const result = await approveJoinRequest({ requestId: 'not-a-uuid' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('returns not-found when the request is missing', async () => {
    mockFindById.mockResolvedValue(undefined);
    const result = await approveJoinRequest({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: 'This request could not be found.' });
  });
});

// ── decline ─────────────────────────────────────────────────────

describe('declineJoinRequest', () => {
  it('ALLOWS an admin — declines + notifies requester (no membership)', async () => {
    mockFindById.mockResolvedValue(companyRequest());
    mockGetMemberRole.mockResolvedValue('admin');
    mockDecline.mockResolvedValue({ request: resolvedRequest() });

    const result = await declineJoinRequest({ requestId: REQUEST_ID });

    expect(result).toEqual({ success: true });
    expect(mockPublish).toHaveBeenCalledWith(
      'party.join_request_declined',
      expect.objectContaining({ correlationId: REQUEST_ID, userId: 'requester-1' })
    );
    expect(mockEmitResolved).toHaveBeenCalledWith(
      'declined',
      expect.objectContaining({
        timeToResolutionSeconds: 10,
        requesterUserId: 'requester-1',
      })
    );
  });

  it('DENIES a base member', async () => {
    mockFindById.mockResolvedValue(companyRequest());
    mockGetMemberRole.mockResolvedValue('member');
    const result = await declineJoinRequest({ requestId: REQUEST_ID });
    expect(result.success).toBe(false);
    expect(mockDecline).not.toHaveBeenCalled();
  });
});

// ── withdraw ────────────────────────────────────────────────────

describe('withdrawJoinRequest', () => {
  it('ALLOWS the requester to withdraw their OWN request (no capability gate)', async () => {
    mockRequireUser.mockResolvedValue({ id: 'requester-1' });
    mockFindById.mockResolvedValue(companyRequest());
    mockWithdraw.mockResolvedValue({ request: resolvedRequest() });

    const result = await withdrawJoinRequest({ requestId: REQUEST_ID });

    expect(result).toEqual({ success: true });
    expect(mockWithdraw).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      actorUserId: 'requester-1',
    });
    // No capability lookup and no admin notification for a self-withdraw.
    expect(mockGetMemberRole).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("DENIES withdrawing someone ELSE's request", async () => {
    mockRequireUser.mockResolvedValue({ id: 'someone-else' });
    mockFindById.mockResolvedValue(companyRequest()); // userId: requester-1

    const result = await withdrawJoinRequest({ requestId: REQUEST_ID });

    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('requires a signed-in user — no lookup or mutation', async () => {
    mockRequireUser.mockRejectedValue(new Error('no session'));

    const result = await withdrawJoinRequest({ requestId: REQUEST_ID });

    expect(result).toEqual({ success: false, error: 'You must be signed in to do this.' });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid requestId — no lookup or mutation', async () => {
    const result = await withdrawJoinRequest({ requestId: 'not-a-uuid' });

    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('returns not-found when the request is missing', async () => {
    mockRequireUser.mockResolvedValue({ id: 'requester-1' });
    mockFindById.mockResolvedValue(undefined);

    const result = await withdrawJoinRequest({ requestId: REQUEST_ID });

    expect(result).toEqual({ success: false, error: 'This request could not be found.' });
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('maps InvalidJoinRequestTransitionError to a friendly message', async () => {
    mockRequireUser.mockResolvedValue({ id: 'requester-1' });
    mockFindById.mockResolvedValue(companyRequest());
    mockWithdraw.mockRejectedValue(new InvalidJoinRequestTransitionError('nope'));

    const result = await withdrawJoinRequest({ requestId: REQUEST_ID });

    expect(result).toEqual({ success: false, error: 'This request is no longer pending.' });
  });

  it('maps a generic failure to the fallback message', async () => {
    mockRequireUser.mockResolvedValue({ id: 'requester-1' });
    mockFindById.mockResolvedValue(companyRequest());
    mockWithdraw.mockRejectedValue(new Error('db exploded'));

    const result = await withdrawJoinRequest({ requestId: REQUEST_ID });

    expect(result).toEqual({
      success: false,
      error: 'Could not withdraw this request. Please try again.',
    });
  });
});
