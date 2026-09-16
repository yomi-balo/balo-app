import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockActorHoldsLive = vi.fn<(userId: string, capability: string) => Promise<boolean>>(
  async () => true
);
vi.mock('@/lib/authz/live-platform-capability', () => ({
  actorHoldsPlatformCapability: (userId: string, capability: string) =>
    mockActorHoldsLive(userId, capability),
}));

// Present only for the R4 composition test at the bottom, which splices the REAL live-gate
// implementation in and makes this read throw.
const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: { findForSessionSync: (...a: unknown[]) => mockFindForSessionSync(...a) },
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

import { PLATFORM_CAPABILITIES, encodeSealedPlatformCapabilities } from '@balo/shared/authz';
import { log } from '@/lib/logging';
import {
  requireRequestStaffCapability,
  REQUEST_STAFF_DENIED,
} from './require-request-staff-capability';

const ADMIN = { id: 'admin-1', platformRole: 'admin' as const };
const SUPER_ADMIN = { id: 'super-1', platformRole: 'super_admin' as const };
const PLAIN_USER = { id: 'user-1', platformRole: 'user' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockActorHoldsLive.mockImplementation(async () => true);
});

describe('requireRequestStaffCapability', () => {
  it('denies when getCurrentUser resolves null — the live gate is NOT consulted', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const result = await requireRequestStaffCapability(
      PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING
    );

    expect(result).toEqual({ ok: false, error: REQUEST_STAFF_DENIED });
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
  });

  it('denies and LOGS when getCurrentUser rejects — the removed requireAdmin() sat inside a try too', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('bad seal'));

    const result = await requireRequestStaffCapability(
      PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING
    );

    expect(result).toEqual({ ok: false, error: REQUEST_STAFF_DENIED });
    expect(log.error).toHaveBeenCalledWith(
      'Session read failed at the request staff-capability gate — denying',
      expect.objectContaining({ capability: PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING })
    );
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
  });

  it('denies a plain user (platformRole "user") — the live gate is NOT consulted', async () => {
    mockGetCurrentUser.mockResolvedValue(PLAIN_USER);

    const result = await requireRequestStaffCapability(
      PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING
    );

    expect(result).toEqual({ ok: false, error: REQUEST_STAFF_DENIED });
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
  });

  it('BAL-560/R3: denies an admin whose LIVE row has revoked the capability, and calls the live gate with the right args', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    mockActorHoldsLive.mockResolvedValueOnce(false);

    const result = await requireRequestStaffCapability(
      PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING
    );

    expect(result).toEqual({ ok: false, error: REQUEST_STAFF_DENIED });
    expect(mockActorHoldsLive).toHaveBeenCalledWith(ADMIN.id, 'manage_any_request_sourcing');
  });

  it('grants an admin whose LIVE row still holds the capability', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);

    const result = await requireRequestStaffCapability(
      PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING
    );

    expect(result).toEqual({ ok: true, user: ADMIN });
  });

  it('grants a super_admin for MANAGE_ANY_KICKOFF_GATE, resolving THAT token on the live gate', async () => {
    mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN);

    const result = await requireRequestStaffCapability(
      PLATFORM_CAPABILITIES.MANAGE_ANY_KICKOFF_GATE
    );

    expect(result).toEqual({ ok: true, user: SUPER_ADMIN });
    expect(mockActorHoldsLive).toHaveBeenCalledWith(SUPER_ADMIN.id, 'manage_any_kickoff_gate');
  });

  it('denies an admin whose SEALED session override OMITS the requested token', async () => {
    mockGetCurrentUser.mockResolvedValue({
      ...ADMIN,
      platformCapabilities: encodeSealedPlatformCapabilities([
        PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN,
      ]),
    });

    const result = await requireRequestStaffCapability(
      PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING
    );

    expect(result).toEqual({ ok: false, error: REQUEST_STAFF_DENIED });
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
  });

  /**
   * ⚠ R4 — THE COMPOSITION TEST, with the REAL live gate spliced in.
   *
   * This helper's OWN `try` wraps only `getCurrentUser()` (the session read). The live gate,
   * `actorHoldsPlatformCapability`, owns a SEPARATE `try` around its own DB read
   * (`live-platform-capability.ts:46-57`) and swallows a throwing read into `false` rather than
   * propagating it. That is what this test proves: a DB failure inside the live gate still
   * resolves to the generic denial, not an unhandled rejection — without this helper needing to
   * catch anything on the live gate's behalf.
   */
  it('R4: a DB failure inside the live gate returns the generic denial, not an unhandled crash', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    const actual = await vi.importActual<typeof import('@/lib/authz/live-platform-capability')>(
      '@/lib/authz/live-platform-capability'
    );
    mockActorHoldsLive.mockImplementationOnce(actual.actorHoldsPlatformCapability as never);
    mockFindForSessionSync.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(
      requireRequestStaffCapability(PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING)
    ).resolves.toEqual({ ok: false, error: REQUEST_STAFF_DENIED });
    expect(mockFindForSessionSync).toHaveBeenCalledWith(ADMIN.id);
  });
});
