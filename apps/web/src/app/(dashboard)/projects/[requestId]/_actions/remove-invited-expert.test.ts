import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformCapability } from '@balo/shared/authz';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const RELATIONSHIP_ID = 'c0000000-0000-4000-8000-000000000002';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindById = vi.fn();
const mockSoftDelete = vi.fn();
vi.mock('@balo/db', () => ({
  requestExpertRelationshipsRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
    softDelete: (...args: unknown[]) => mockSoftDelete(...args),
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

import { removeInvitedExpertAction } from './remove-invited-expert';
import { revalidatePath } from 'next/cache';

const ADMIN = { id: 'admin-1', platformRole: 'admin' as const };
const PERMISSION_DENIED = 'You do not have permission to do this.';

describe('removeInvitedExpertAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    mockActorHoldsLive.mockImplementation(async () => true);
    mockFindById.mockResolvedValue({
      id: RELATIONSHIP_ID,
      projectRequestId: REQUEST_ID,
      status: 'invited',
    });
    mockSoftDelete.mockResolvedValue({ id: RELATIONSHIP_ID });
  });

  it('denies an unauthenticated caller; no repo/revalidate call', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await removeInvitedExpertAction({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
    });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockSoftDelete).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('denies a session-uncapable caller (platformRole "user"); live gate NOT called', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
    const result = await removeInvitedExpertAction({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
    });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('BAL-560/BAL-558: denies when the LIVE row has revoked the capability, though the cookie still grants', async () => {
    mockActorHoldsLive.mockResolvedValueOnce(false);
    const result = await removeInvitedExpertAction({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
    });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockSoftDelete).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(mockActorHoldsLive).toHaveBeenCalledWith(ADMIN.id, 'manage_any_request_sourcing');
  });

  it('ordering: an uncapable caller with INVALID input gets the permission denial, not the validation message', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
    const result = await removeInvitedExpertAction({
      requestId: 'bad',
      relationshipId: RELATIONSHIP_ID,
    });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
  });

  it('a thrown session read resolves to the permission denial, not an unhandled rejection', async () => {
    mockGetCurrentUser.mockRejectedValueOnce(new Error('bad seal'));
    await expect(
      removeInvitedExpertAction({ requestId: REQUEST_ID, relationshipId: RELATIONSHIP_ID })
    ).resolves.toEqual({ success: false, error: PERMISSION_DENIED });
  });

  it('rejects invalid ids', async () => {
    const result = await removeInvitedExpertAction({
      requestId: 'bad',
      relationshipId: RELATIONSHIP_ID,
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
  });

  it('rejects when the relationship is missing', async () => {
    mockFindById.mockResolvedValue(undefined);
    const result = await removeInvitedExpertAction({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
    });
    expect(result).toEqual({ success: false, error: 'This expert can no longer be removed.' });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('rejects when the relationship belongs to a different request', async () => {
    mockFindById.mockResolvedValue({
      id: RELATIONSHIP_ID,
      projectRequestId: 'other-request',
      status: 'invited',
    });
    const result = await removeInvitedExpertAction({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
    });
    expect(result).toEqual({ success: false, error: 'This expert can no longer be removed.' });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('rejects when the relationship is past invited (eoi_submitted)', async () => {
    mockFindById.mockResolvedValue({
      id: RELATIONSHIP_ID,
      projectRequestId: REQUEST_ID,
      status: 'eoi_submitted',
    });
    const result = await removeInvitedExpertAction({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
    });
    expect(result).toEqual({ success: false, error: 'This expert can no longer be removed.' });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('soft-deletes and revalidates on the happy path', async () => {
    const result = await removeInvitedExpertAction({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
    });
    expect(mockSoftDelete).toHaveBeenCalledWith(RELATIONSHIP_ID);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(result).toEqual({ success: true });
  });

  it('returns a generic error on an unexpected failure', async () => {
    mockSoftDelete.mockRejectedValue(new Error('DB down'));
    const result = await removeInvitedExpertAction({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
    });
    expect(result).toEqual({
      success: false,
      error: 'Could not remove this expert. Please try again.',
    });
  });
});
