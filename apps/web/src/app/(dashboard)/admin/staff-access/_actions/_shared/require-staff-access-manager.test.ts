import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-561 — mirrors `require-application-reviewer.test.ts`'s shape. Unlike
 * `review_expert_applications` (shared by both staff roles), `manage_staff_capabilities` is
 * `super_admin`-ONLY (never in `PLATFORM_STAFF_BUNDLE`), so the REAL platform map already
 * discriminates `admin` from `super_admin` — no capability-seam mock is needed to prove the
 * helper resolves the right token instead of leaning on the layout's `VIEW_PLATFORM_ADMIN` gate.
 */
const mockActorHoldsLive = vi.fn<
  (userId: string, capability: PlatformCapability) => Promise<boolean>
>(async () => true);
vi.mock('@/lib/authz/live-platform-capability', () => ({
  actorHoldsPlatformCapability: (userId: string, capability: PlatformCapability) =>
    mockActorHoldsLive(userId, capability),
}));

vi.mock('server-only', () => ({}));

const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: { findForSessionSync: (...a: unknown[]) => mockFindForSessionSync(...a) },
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

import { PLATFORM_CAPABILITIES, type PlatformCapability } from '@balo/shared/authz';
import { STAFF_ACCESS_SAVE_MESSAGES } from '../../_lib/staff-access-outcome';
import { requireStaffAccessManager } from './require-staff-access-manager';

const SUPER_ADMIN = { id: 'super-1', platformRole: 'super_admin' as const };
const ADMIN = { id: 'admin-1', platformRole: 'admin' as const };
const PLAIN_USER = { id: 'user-1', platformRole: 'user' as const };
// C5 — during an impersonated session `getCurrentUser()` returns the IMPERSONATED account, which
// is why this fixture is otherwise shaped like a fully-eligible super_admin: the point of C5's
// check is that it refuses BEFORE either capability read even considers that shape.
const IMPERSONATED_SUPER_ADMIN = {
  ...SUPER_ADMIN,
  isImpersonating: true,
  impersonatorUserId: 'staff-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockActorHoldsLive.mockResolvedValue(true);
});

describe('requireStaffAccessManager', () => {
  it('denies a signed-out caller and never calls the live gate', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await requireStaffAccessManager();
    expect(result).toEqual({ ok: false, error: STAFF_ACCESS_SAVE_MESSAGES.denied });
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
  });

  it('denies a plain user (no staff role) with the SAME string, and never calls the live gate', async () => {
    mockGetCurrentUser.mockResolvedValue(PLAIN_USER);
    const result = await requireStaffAccessManager();
    expect(result).toEqual({ ok: false, error: STAFF_ACCESS_SAVE_MESSAGES.denied });
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
  });

  it('C5: denies an IMPERSONATED session with the SAME string, and never calls the live gate', async () => {
    mockGetCurrentUser.mockResolvedValue(IMPERSONATED_SUPER_ADMIN);
    const result = await requireStaffAccessManager();
    expect(result).toEqual({ ok: false, error: STAFF_ACCESS_SAVE_MESSAGES.denied });
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
  });

  it('denies "admin" — support does not hold manage_staff_capabilities — with the SAME string, and never calls the live gate', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    const result = await requireStaffAccessManager();
    expect(result).toEqual({ ok: false, error: STAFF_ACCESS_SAVE_MESSAGES.denied });
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
  });

  it('BAL-560/F2: denies super_admin when the LIVE row has revoked the token', async () => {
    mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN);
    mockActorHoldsLive.mockResolvedValueOnce(false);

    const result = await requireStaffAccessManager();

    expect(result).toEqual({ ok: false, error: STAFF_ACCESS_SAVE_MESSAGES.denied });
    expect(mockActorHoldsLive).toHaveBeenCalledWith(
      SUPER_ADMIN.id,
      PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES
    );
  });

  it('grants super_admin when the session AND the live row both agree', async () => {
    mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN);
    const result = await requireStaffAccessManager();
    expect(result).toEqual({ ok: true, user: SUPER_ADMIN });
  });

  it('R4-style: a DB failure inside the live gate denies rather than crashing', async () => {
    mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN);
    const actual = await vi.importActual<typeof import('@/lib/authz/live-platform-capability')>(
      '@/lib/authz/live-platform-capability'
    );
    mockActorHoldsLive.mockImplementationOnce(actual.actorHoldsPlatformCapability);
    mockFindForSessionSync.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(requireStaffAccessManager()).resolves.toEqual({
      ok: false,
      error: STAFF_ACCESS_SAVE_MESSAGES.denied,
    });
    expect(mockFindForSessionSync).toHaveBeenCalledWith(SUPER_ADMIN.id);
  });
});
