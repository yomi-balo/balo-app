import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformCapability } from '@balo/shared/authz';

/**
 * BAL-560 fix round 1 (security F2) — the LIVE-ROW platform gate this action now runs after its
 * synchronous session check. Mocked to GRANT by default, so every pre-existing case below still
 * exercises exactly what it did before: the session gate is still what decides them. The helper's
 * own behaviour (override revoked / widened / row suspended / non-staff role) is covered
 * exhaustively in `lib/authz/live-platform-capability.test.ts`; what the suites here pin is that
 * the action CALLS it and honours a denial.
 */
const mockActorHoldsLive = vi.fn<
  (userId: string, capability: PlatformCapability) => Promise<boolean>
>(async () => true);
vi.mock('@/lib/authz/live-platform-capability', () => ({
  actorHoldsPlatformCapability: (userId: string, capability: PlatformCapability) =>
    mockActorHoldsLive(userId, capability),
}));

vi.mock('server-only', () => ({}));

// Present only for the R4 composition test at the bottom, which splices the REAL live-gate
// implementation in and makes this read throw.
const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: { findForSessionSync: (...a: unknown[]) => mockFindForSessionSync(...a) },
}));

const { mockGetCurrentUser, mockHasPlatformCapability } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockHasPlatformCapability: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

/*
  FIX ROUND F11 — WHY THE CAPABILITY SEAM IS MOCKED HERE.

  `review_expert_applications` and `view_platform_admin` are BOTH in `PLATFORM_STAFF_BUNDLE`, so
  for EVERY role string `platformRoleHasCapability(role, REVIEW_EXPERT_APPLICATIONS) ===
  platformRoleHasCapability(role, VIEW_PLATFORM_ADMIN)`. A role-driven test therefore CANNOT
  fail under the defect it claims to cover ("the action leans on the layout gate") — flipping
  this helper to `VIEW_PLATFORM_ADMIN` leaves every such test green. The only thing that
  discriminates is the ARGUMENT this helper passes, which is what the identity test below
  asserts. Both actions route through this helper, so pinning it here pins both.

  The default implementation delegates to the REAL platform map, so the four role arms below
  stay end-to-end over the shipped bundle.
*/
vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/authz/platform')>();
  return {
    ...actual,
    hasPlatformCapability: (...args: Parameters<typeof actual.hasPlatformCapability>): boolean =>
      mockHasPlatformCapability(...args),
  };
});

import { PLATFORM_CAPABILITIES, platformRoleHasCapability } from '@balo/shared/authz';
import { requireApplicationReviewer, REVIEWER_DENIED } from './require-application-reviewer';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const SUPER_ADMIN = { id: 'super-1', platformRole: 'super_admin' };
const PLAIN_USER = { id: 'user-1', platformRole: 'user' };

beforeEach(() => {
  vi.clearAllMocks();
  mockHasPlatformCapability.mockImplementation(
    (user: { platformRole: 'user' | 'admin' | 'super_admin' }, capability: string) =>
      platformRoleHasCapability(user.platformRole, capability as never)
  );
});

describe('requireApplicationReviewer', () => {
  it('denies a signed-out caller with the generic denial', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await requireApplicationReviewer();
    expect(result).toEqual({ ok: false, error: REVIEWER_DENIED });
  });

  it('denies a caller WITHOUT review_expert_applications (a plain user), with the SAME string as the signed-out arm', async () => {
    mockGetCurrentUser.mockResolvedValue(PLAIN_USER);
    const result = await requireApplicationReviewer();
    expect(result).toEqual({ ok: false, error: REVIEWER_DENIED });
  });

  // ⚠ BAL-560/F2 — the cookie still grants; the LIVE row does not. A Server Action never runs
  // `checkSessionDrift`, so this is the only thing enforcing a revoked override on this path.
  it('BAL-560/F2: denies when the LIVE row has revoked the override', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    mockActorHoldsLive.mockResolvedValueOnce(false);

    const result = await requireApplicationReviewer();

    expect(result).toEqual({ ok: false, error: REVIEWER_DENIED });
    expect(mockActorHoldsLive).toHaveBeenCalledWith(ADMIN.id, 'review_expert_applications');
  });

  it('grants the support role (platformRole "admin")', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    const result = await requireApplicationReviewer();
    expect(result).toEqual({ ok: true, user: ADMIN });
  });

  it('grants super_admin', async () => {
    mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN);
    const result = await requireApplicationReviewer();
    expect(result).toEqual({ ok: true, user: SUPER_ADMIN });
  });

  /**
   * FIX ROUND F11 — THE TOKEN-IDENTITY PIN, for BOTH decision actions.
   *
   * MUTATION-PROVEN: change `require-application-reviewer.ts` to resolve
   * `PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN` and this test — and only this test — goes red.
   * That mutation IS the "leans on the layout gate" defect, and nothing else in the suite
   * notices it, because the two tokens are co-held by every role.
   */
  it('resolves REVIEW_EXPERT_APPLICATIONS — the token itself, not the layout gate’s', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);

    await requireApplicationReviewer();

    expect(mockHasPlatformCapability).toHaveBeenCalledWith(
      ADMIN,
      PLATFORM_CAPABILITIES.REVIEW_EXPERT_APPLICATIONS
    );
    expect(mockHasPlatformCapability).not.toHaveBeenCalledWith(
      expect.anything(),
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN
    );
  });

  /**
   * The gate is the seam's ANSWER, not the role string — so a future bundle split that revokes
   * `review_expert_applications` from a staff role denies here without this file changing.
   */
  it('denies a staff-role caller the moment the capability seam says no', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    mockHasPlatformCapability.mockReturnValue(false);

    expect(await requireApplicationReviewer()).toEqual({ ok: false, error: REVIEWER_DENIED });
  });

  /**
   * ⚠ FIX ROUND 3 (R4) — THE COMPOSITION TEST for the shared-preamble shape, with the REAL live
   * gate spliced in.
   *
   * The gate runs as the preamble's LAST statement and therefore ahead of every caller's own
   * `try`; if the helper propagated a DB failure, both decision actions would reject unhandled
   * instead of returning `{ ok: false }`. The helper owns the `try` for that reason.
   */
  it('R4: a DB failure inside the live gate returns the generic denial, not an unhandled crash', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    const actual = await vi.importActual<typeof import('@/lib/authz/live-platform-capability')>(
      '@/lib/authz/live-platform-capability'
    );
    // `Once` on both: `vi.clearAllMocks()` clears CALLS but KEEPS implementations.
    mockActorHoldsLive.mockImplementationOnce(actual.actorHoldsPlatformCapability);
    mockFindForSessionSync.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(requireApplicationReviewer()).resolves.toEqual({
      ok: false,
      error: REVIEWER_DENIED,
    });
    expect(mockFindForSessionSync).toHaveBeenCalledWith(ADMIN.id);
  });
});
