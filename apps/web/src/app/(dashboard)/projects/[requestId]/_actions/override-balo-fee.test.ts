import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-560 fix round 3 (R3) — the LIVE-ROW platform gate this action now runs after its
 * synchronous session check. Mocked to GRANT by default, so every pre-existing case below still
 * exercises exactly what it did before: the session gate is still what decides them. The helper's
 * own behaviour (override revoked / widened / row suspended / non-staff role / DB throw) is
 * covered exhaustively in `lib/authz/live-platform-capability.test.ts`; what the suite here pins
 * is that the action CALLS it and honours a denial.
 */
const mockActorHoldsLive = vi.fn<(userId: string, capability: string) => Promise<boolean>>(
  async () => true
);
vi.mock('@/lib/authz/live-platform-capability', () => ({
  actorHoldsPlatformCapability: (userId: string, capability: string) =>
    mockActorHoldsLive(userId, capability),
}));

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
// `usersRepository` is here only for the R4 composition test at the bottom, which swaps the REAL
// live-gate implementation in and makes this read throw.
const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    updateBaloFeeBps: (...a: unknown[]) => mockUpdateBaloFeeBps(...a),
  },
  usersRepository: {
    findForSessionSync: (...a: unknown[]) => mockFindForSessionSync(...a),
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

  it('BAL-560/R3: denies when the LIVE row has revoked the override, though the cookie still grants', async () => {
    mockActorHoldsLive.mockResolvedValueOnce(false);
    const result = await overrideBaloFee(VALID_INPUT);
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockUpdateBaloFeeBps).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockActorHoldsLive).toHaveBeenCalledWith(ADMIN.id, 'manage_platform_fees');
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

  /**
   * ⚠ FIX ROUND 3 (R4) — THE COMPOSITION TEST, with the REAL live gate spliced in.
   *
   * The gate sits ABOVE this action's `try` on purpose (capability resolved BEFORE the input is
   * parsed — no existence leak), so if the helper propagated a DB failure the action would reject
   * unhandled instead of returning its normal message. The helper owns the `try` for that reason.
   * Every other case in this file mocks the helper; this one runs the shipped implementation
   * against a throwing `usersRepository` read.
   */
  it('R4: a DB failure inside the live gate returns the normal denial, not an unhandled crash', async () => {
    const actual = await vi.importActual<typeof import('@/lib/authz/live-platform-capability')>(
      '@/lib/authz/live-platform-capability'
    );
    // `Once` on both: `vi.clearAllMocks()` clears CALLS but KEEPS implementations, so a
    // persistent `mockImplementation` here would deny every later test in the file.
    mockActorHoldsLive.mockImplementationOnce(actual.actorHoldsPlatformCapability);
    mockFindForSessionSync.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(overrideBaloFee(VALID_INPUT)).resolves.toEqual({
      success: false,
      error: PERMISSION_DENIED,
    });
    expect(mockFindForSessionSync).toHaveBeenCalledWith(ADMIN.id);
    expect(mockUpdateBaloFeeBps).not.toHaveBeenCalled();
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
