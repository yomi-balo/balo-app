import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const mockRequireAdmin = vi.fn();
vi.mock('@/lib/auth/require-admin', () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

import { removeInvitedExpertAction } from './remove-invited-expert';
import { revalidatePath } from 'next/cache';

describe('removeInvitedExpertAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ id: 'admin-1', platformRole: 'admin' });
    mockFindById.mockResolvedValue({
      id: RELATIONSHIP_ID,
      projectRequestId: REQUEST_ID,
      status: 'invited',
    });
    mockSoftDelete.mockResolvedValue({ id: RELATIONSHIP_ID });
  });

  it('rejects a non-admin', async () => {
    mockRequireAdmin.mockRejectedValue(new Error('Forbidden'));
    const result = await removeInvitedExpertAction({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
    });
    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
    expect(mockSoftDelete).not.toHaveBeenCalled();
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
