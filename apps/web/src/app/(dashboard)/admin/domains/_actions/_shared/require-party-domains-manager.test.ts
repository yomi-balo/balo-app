import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformCapability } from '@balo/shared/authz';

const mockActorHoldsLive = vi.fn<
  (userId: string, capability: PlatformCapability) => Promise<boolean>
>(async () => true);
vi.mock('@/lib/authz/live-platform-capability', () => ({
  actorHoldsPlatformCapability: (userId: string, capability: PlatformCapability) =>
    mockActorHoldsLive(userId, capability),
}));

vi.mock('server-only', () => ({}));

const { mockGetCurrentUser, mockHasPlatformCapability } = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockHasPlatformCapability: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/authz/platform')>();
  return {
    ...actual,
    hasPlatformCapability: (...args: Parameters<typeof actual.hasPlatformCapability>): boolean =>
      mockHasPlatformCapability(...args),
  };
});

import { PLATFORM_CAPABILITIES, platformRoleHasCapability } from '@balo/shared/authz';
import { requirePartyDomainsManager, PARTY_DOMAINS_DENIED } from './require-party-domains-manager';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const SUPER_ADMIN = { id: 'super-1', platformRole: 'super_admin' };
const PLAIN_USER = { id: 'user-1', platformRole: 'user' };

beforeEach(() => {
  vi.clearAllMocks();
  mockActorHoldsLive.mockResolvedValue(true);
  mockHasPlatformCapability.mockImplementation(
    (user: { platformRole: 'user' | 'admin' | 'super_admin' }, capability: string) =>
      platformRoleHasCapability(user.platformRole, capability as never)
  );
});

describe('requirePartyDomainsManager', () => {
  it('denies a signed-out caller with the generic denial', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect(await requirePartyDomainsManager()).toEqual({ ok: false, error: PARTY_DOMAINS_DENIED });
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
  });

  it('refuses an impersonated session before either capability read', async () => {
    mockGetCurrentUser.mockResolvedValue({ ...ADMIN, isImpersonating: true });
    expect(await requirePartyDomainsManager()).toEqual({ ok: false, error: PARTY_DOMAINS_DENIED });
    expect(mockHasPlatformCapability).not.toHaveBeenCalled();
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
  });

  it('denies a plain user with the SAME string, before the live read', async () => {
    mockGetCurrentUser.mockResolvedValue(PLAIN_USER);
    expect(await requirePartyDomainsManager()).toEqual({ ok: false, error: PARTY_DOMAINS_DENIED });
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
  });

  it('denies when the LIVE row has revoked the capability though the session still grants', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    mockActorHoldsLive.mockResolvedValueOnce(false);

    expect(await requirePartyDomainsManager()).toEqual({ ok: false, error: PARTY_DOMAINS_DENIED });
    expect(mockActorHoldsLive).toHaveBeenCalledWith(ADMIN.id, 'manage_party_domains');
  });

  it('grants admin and super_admin', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    expect(await requirePartyDomainsManager()).toEqual({ ok: true, user: ADMIN });
    mockGetCurrentUser.mockResolvedValue(SUPER_ADMIN);
    expect(await requirePartyDomainsManager()).toEqual({ ok: true, user: SUPER_ADMIN });
  });

  it('resolves MANAGE_PARTY_DOMAINS itself, not the layout gate token', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);

    await requirePartyDomainsManager();

    expect(mockHasPlatformCapability).toHaveBeenCalledWith(
      ADMIN,
      PLATFORM_CAPABILITIES.MANAGE_PARTY_DOMAINS
    );
    expect(mockHasPlatformCapability).not.toHaveBeenCalledWith(
      expect.anything(),
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN
    );
  });

  it('denies the moment the capability seam says no', async () => {
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    mockHasPlatformCapability.mockReturnValue(false);
    expect(await requirePartyDomainsManager()).toEqual({ ok: false, error: PARTY_DOMAINS_DENIED });
  });
});
