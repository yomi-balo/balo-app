import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_OWNER_ID = 'b0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindByIdWithRelations = vi.fn();
const mockAssignOwner = vi.fn();
const mockFindNamesByIds = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...a: unknown[]) => mockFindByIdWithRelations(...a),
    assignOwner: (...a: unknown[]) => mockAssignOwner(...a),
  },
  usersRepository: {
    findNamesByIds: (...a: unknown[]) => mockFindNamesByIds(...a),
  },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockRunAssignOwnerFanout = vi.fn();
vi.mock('./_shared/assign-owner-fanout', () => ({
  runAssignOwnerFanout: (...a: unknown[]) => mockRunAssignOwnerFanout(...a),
}));

import { assignRequestOwnerAction } from './assign-request-owner';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN_ID = 'c0000000-0000-4000-8000-000000000009';
const ADMIN = { id: ADMIN_ID, platformRole: 'admin' };

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    title: 'CPQ implementation',
    companyId: 'company-1',
    company: { id: 'company-1', name: 'Acme Corp' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(ADMIN);
  mockFindByIdWithRelations.mockResolvedValue(requestRow());
  mockFindNamesByIds.mockResolvedValue([]);
});

describe('assignRequestOwnerAction', () => {
  it('rejects an unauthenticated caller', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await assignRequestOwnerAction({ requestId: REQUEST_ID, ownerUserId: OWNER_ID });
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockAssignOwner).not.toHaveBeenCalled();
  });

  it('denies a plain user (no platform capability) before touching the repo', async () => {
    mockRequireOnboardedUser.mockResolvedValue({ id: 'u-2', platformRole: 'user' });
    const result = await assignRequestOwnerAction({ requestId: REQUEST_ID, ownerUserId: OWNER_ID });
    expect(result).toEqual({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
    expect(mockAssignOwner).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid ownerUserId', async () => {
    const result = await assignRequestOwnerAction({
      requestId: REQUEST_ID,
      ownerUserId: 'not-a-uuid' as never,
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockAssignOwner).not.toHaveBeenCalled();
  });

  it('returns a gone message when the request no longer exists', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    const result = await assignRequestOwnerAction({ requestId: REQUEST_ID, ownerUserId: OWNER_ID });
    expect(result).toEqual({
      success: false,
      error: 'This request no longer exists.',
      code: 'gone',
    });
    expect(mockAssignOwner).not.toHaveBeenCalled();
  });

  it('maps not_staff and owner_not_found to the SAME message and code (no existence leak)', async () => {
    mockAssignOwner.mockResolvedValue({ outcome: 'not_staff', candidateUserId: OWNER_ID });
    const notStaff = await assignRequestOwnerAction({
      requestId: REQUEST_ID,
      ownerUserId: OWNER_ID,
    });
    expect(notStaff).toEqual({
      success: false,
      error: 'That person is not a Balo staff member.',
      code: 'not_staff',
    });
    expect(log.warn).toHaveBeenCalledWith('Balo owner assignment refused', {
      requestId: REQUEST_ID,
      actorUserId: ADMIN_ID,
      outcome: 'not_staff',
    });

    mockAssignOwner.mockResolvedValue({ outcome: 'owner_not_found', candidateUserId: OWNER_ID });
    const notFound = await assignRequestOwnerAction({
      requestId: REQUEST_ID,
      ownerUserId: OWNER_ID,
    });
    expect(notFound).toEqual(notStaff);
    expect(log.warn).toHaveBeenCalledWith('Balo owner assignment refused', {
      requestId: REQUEST_ID,
      actorUserId: ADMIN_ID,
      outcome: 'owner_not_found',
    });
  });

  it('unchanged: returns changed:false, resolves the current owner name, and never fans out', async () => {
    mockAssignOwner.mockResolvedValue({ outcome: 'unchanged', ownerUserId: OWNER_ID });
    mockFindNamesByIds.mockResolvedValue([{ id: OWNER_ID, firstName: 'Dana', lastName: 'Ho' }]);

    const result = await assignRequestOwnerAction({ requestId: REQUEST_ID, ownerUserId: OWNER_ID });

    expect(result).toEqual({
      success: true,
      owner: { userId: OWNER_ID, name: 'Dana Ho' },
      changed: false,
      analytics: { requestId: REQUEST_ID, previousOwnerPresent: true, selfAssigned: false },
    });
    expect(mockRunAssignOwnerFanout).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('unchanged on a clear (re-clearing an already-unassigned request): owner null, previousOwnerPresent false', async () => {
    mockAssignOwner.mockResolvedValue({ outcome: 'unchanged', ownerUserId: null });
    const result = await assignRequestOwnerAction({ requestId: REQUEST_ID, ownerUserId: null });
    expect(result).toEqual({
      success: true,
      owner: null,
      changed: false,
      analytics: { requestId: REQUEST_ID, previousOwnerPresent: false, selfAssigned: false },
    });
  });

  it('assigned: logs, fans out with the audit id as correlationId, resolves the new owner name, revalidates both paths', async () => {
    mockAssignOwner.mockResolvedValue({
      outcome: 'assigned',
      previousOwnerUserId: null,
      ownerUserId: OWNER_ID,
      auditId: 'audit-1',
    });
    mockFindNamesByIds.mockResolvedValue([{ id: OWNER_ID, firstName: 'Dana', lastName: 'Ho' }]);

    const result = await assignRequestOwnerAction({ requestId: REQUEST_ID, ownerUserId: OWNER_ID });

    expect(result).toEqual({
      success: true,
      owner: { userId: OWNER_ID, name: 'Dana Ho' },
      changed: true,
      analytics: { requestId: REQUEST_ID, previousOwnerPresent: false, selfAssigned: false },
    });
    expect(mockRunAssignOwnerFanout).toHaveBeenCalledWith({
      correlationId: 'audit-1',
      projectRequestId: REQUEST_ID,
      newOwnerUserId: OWNER_ID,
      assignedByUserId: ADMIN.id,
      title: 'CPQ implementation',
      clientCompanyName: 'Acme Corp',
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith('/projects');
    expect(log.info).toHaveBeenCalledWith(
      'Balo owner assigned',
      expect.objectContaining({ requestId: REQUEST_ID, ownerUserId: OWNER_ID, cleared: false })
    );
  });

  it('clearing (ownerUserId: null) never calls the fan-out — D11: no event on clear', async () => {
    mockAssignOwner.mockResolvedValue({
      outcome: 'assigned',
      previousOwnerUserId: OWNER_ID,
      ownerUserId: null,
      auditId: 'audit-2',
    });

    const result = await assignRequestOwnerAction({ requestId: REQUEST_ID, ownerUserId: null });

    expect(result).toEqual({
      success: true,
      owner: null,
      changed: true,
      analytics: { requestId: REQUEST_ID, previousOwnerPresent: true, selfAssigned: false },
    });
    expect(mockRunAssignOwnerFanout).not.toHaveBeenCalled();
    expect(mockFindNamesByIds).not.toHaveBeenCalled();
  });

  it('sets selfAssigned:true when the actor assigns themselves', async () => {
    mockAssignOwner.mockResolvedValue({
      outcome: 'assigned',
      previousOwnerUserId: null,
      ownerUserId: ADMIN.id,
      auditId: 'audit-3',
    });
    mockFindNamesByIds.mockResolvedValue([{ id: ADMIN.id, firstName: 'Admin', lastName: 'One' }]);

    const result = await assignRequestOwnerAction({ requestId: REQUEST_ID, ownerUserId: ADMIN.id });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.analytics.selfAssigned).toBe(true);
    }
  });

  it('reassignment (previous owner present, different new owner): previousOwnerPresent true', async () => {
    mockAssignOwner.mockResolvedValue({
      outcome: 'assigned',
      previousOwnerUserId: OWNER_ID,
      ownerUserId: OTHER_OWNER_ID,
      auditId: 'audit-4',
    });
    mockFindNamesByIds.mockResolvedValue([
      { id: OTHER_OWNER_ID, firstName: 'Priya', lastName: 'Nair' },
    ]);

    const result = await assignRequestOwnerAction({
      requestId: REQUEST_ID,
      ownerUserId: OTHER_OWNER_ID,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.analytics.previousOwnerPresent).toBe(true);
    }
    expect(mockRunAssignOwnerFanout).toHaveBeenCalledWith(
      expect.objectContaining({ newOwnerUserId: OTHER_OWNER_ID })
    );
  });

  it('a generic thrown error is logged and returns a generic failure', async () => {
    mockAssignOwner.mockRejectedValue(new Error('db exploded'));
    const result = await assignRequestOwnerAction({ requestId: REQUEST_ID, ownerUserId: OWNER_ID });
    expect(result).toEqual({
      success: false,
      error: 'Could not update the Balo owner. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to assign Balo owner',
      expect.objectContaining({ requestId: REQUEST_ID, error: 'db exploded' })
    );
  });
});
