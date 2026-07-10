import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

// The authz seam is REAL (pure `@balo/shared/authz` map) so the capability gate is
// exercised end-to-end; only the session user's `platformRole` is controlled.
const mockFindById = vi.fn();
const mockUpdateBaloFeeBps = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    updateBaloFeeBps: (...a: unknown[]) => mockUpdateBaloFeeBps(...a),
  },
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  PROJECT_SERVER_EVENTS: {
    ADMIN_PROJECT_FEE_OVERRIDDEN: 'admin_project_fee_overridden',
  },
}));

import { overrideBaloFee } from './override-balo-fee';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const VALID_INPUT = { requestId: REQUEST_ID, feeBps: 1750 };

const PERMISSION_DENIED = 'You do not have permission to do this.';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(ADMIN);
  mockFindById.mockResolvedValue({ id: REQUEST_ID });
  mockUpdateBaloFeeBps.mockResolvedValue({ previousBps: 2500, newBps: 1750, changed: true });
});

describe('overrideBaloFee', () => {
  it('denies an unauthenticated caller before touching the repo (no existence leak)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await overrideBaloFee(VALID_INPUT);
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockUpdateBaloFeeBps).not.toHaveBeenCalled();
  });

  it('denies a viewer without MANAGE_PLATFORM_FEES (plain user)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-2', platformRole: 'user' });
    const result = await overrideBaloFee(VALID_INPUT);
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockUpdateBaloFeeBps).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range fee before hitting the repo', async () => {
    const result = await overrideBaloFee({ requestId: REQUEST_ID, feeBps: 10_001 });
    expect(result).toEqual({ success: false, error: 'Enter a fee between 0% and 100%.' });
    expect(mockUpdateBaloFeeBps).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid requestId', async () => {
    const result = await overrideBaloFee({ requestId: 'nope', feeBps: 1750 });
    expect(result).toEqual({ success: false, error: 'Enter a fee between 0% and 100%.' });
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('returns a stale-UI message when the request is gone', async () => {
    mockFindById.mockResolvedValue(undefined);
    const result = await overrideBaloFee(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This request no longer exists.' });
    expect(mockUpdateBaloFeeBps).not.toHaveBeenCalled();
  });

  it('updates the fee, emits analytics + log.info, and revalidates on a real change', async () => {
    const result = await overrideBaloFee(VALID_INPUT);

    expect(mockUpdateBaloFeeBps).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      newBps: 1750,
      actorUserId: 'admin-1',
    });
    expect(mockTrack).toHaveBeenCalledWith('admin_project_fee_overridden', {
      project_request_id: REQUEST_ID,
      previous_bps: 2500,
      new_bps: 1750,
      distinct_id: 'admin-1',
    });
    expect(log.info).toHaveBeenCalledWith(
      'Admin overrode project Balo fee',
      expect.objectContaining({ requestId: REQUEST_ID, actorUserId: 'admin-1', newBps: 1750 })
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(result).toEqual({ success: true, previousBps: 2500, newBps: 1750, changed: true });
  });

  it('allows a super_admin', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'sa-1', platformRole: 'super_admin' });
    const result = await overrideBaloFee(VALID_INPUT);
    expect(result).toEqual({ success: true, previousBps: 2500, newBps: 1750, changed: true });
  });

  it('on a no-op (unchanged) returns changed:false and emits NO analytics or log.info', async () => {
    mockUpdateBaloFeeBps.mockResolvedValue({ previousBps: 2500, newBps: 2500, changed: false });
    const result = await overrideBaloFee({ requestId: REQUEST_ID, feeBps: 2500 });
    expect(result).toEqual({ success: true, previousBps: 2500, newBps: 2500, changed: false });
    expect(mockTrack).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    // Still revalidates so any stale render reconciles.
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('maps a repo throw to the generic error and logs it', async () => {
    mockUpdateBaloFeeBps.mockRejectedValue(new Error('DB down'));
    const result = await overrideBaloFee(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not update the fee. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to override project Balo fee',
      expect.objectContaining({ error: 'DB down', actorUserId: 'admin-1' })
    );
  });
});
