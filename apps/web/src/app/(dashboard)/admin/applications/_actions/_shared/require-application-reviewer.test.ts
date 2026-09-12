import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

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
});
