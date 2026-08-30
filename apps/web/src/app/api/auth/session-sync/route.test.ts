import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { Workspace } from '@balo/shared/workspaces';

// ── Mocks ───────────────────────────────────────────────────────

const mockFindForSessionSync = vi.fn();
const mockUpdate = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

const mockGetSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSession: () => mockGetSession(),
}));

const { mockLogInfo, mockLogWarn } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  log: {
    info: mockLogInfo,
    warn: mockLogWarn,
    error: vi.fn(),
  },
}));

const PERSONAL_ID = 'company-1';
const COMPANY_WORKSPACE = {
  type: 'company' as const,
  key: `company:${PERSONAL_ID}`,
  companyId: PERSONAL_ID,
  name: 'Test Company',
  via: 'membership' as const,
  isPersonal: true,
  role: 'owner' as const,
};
const EXPERT_WORKSPACE = { type: 'expert' as const, key: 'expert' };

function materials(overrides: Record<string, unknown> = {}) {
  return {
    input: {
      hasApprovedExpertProfile: false,
      memberships: [
        { companyId: PERSONAL_ID, name: 'Test Company', isPersonal: true, role: 'owner' },
      ],
      eligibleCompanyIds: [PERSONAL_ID],
      representedCompanies: [],
    },
    stored: { activeMode: 'client', activeCompanyId: null },
    ...overrides,
  };
}

/**
 * Materials for an actor whose DB row still says `active_mode:'expert'`. `approved` decides
 * whether an expert workspace is derivable — i.e. whether the route's narrow repair write
 * fires. Hoisted because three cases need the identical block (Sonar duplication gate).
 */
function expertModeMaterials(approved: boolean) {
  return materials({
    input: {
      hasApprovedExpertProfile: approved,
      memberships: [
        { companyId: PERSONAL_ID, name: 'Test Company', isPersonal: true, role: 'owner' },
      ],
      eligibleCompanyIds: [PERSONAL_ID],
      representedCompanies: [],
    },
    stored: { activeMode: 'expert', activeCompanyId: null },
  });
}

const mockLoadWorkspaceDerivationMaterials = vi.fn();
vi.mock('@/lib/workspaces/derive-workspaces', () => ({
  loadWorkspaceDerivationMaterials: (...args: unknown[]) =>
    mockLoadWorkspaceDerivationMaterials(...args),
}));

import { GET } from './route';

// ── Helpers ─────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3000';

function makeRequest(queryString = ''): NextRequest {
  const suffix = queryString ? `?${queryString}` : '';
  const url = `${BASE_URL}/api/auth/session-sync${suffix}`;
  return new NextRequest(new URL(url));
}

function createMockSession(userOverrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: 'user-1',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      activeMode: 'client',
      platformRole: 'user',
      onboardingCompleted: true,
      companyId: 'company-1',
      companyName: 'Test Company',
      companyRole: 'owner',
      expertProfileId: undefined,
      // BAL-494 / ADR-1053 — typed (not left to inference) so the route's mutations of
      // `session.user.activeWorkspace` (asserted on below) typechecks.
      activeWorkspace: undefined as Workspace | undefined,
      ...userOverrides,
    },
    save: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  };
}

function createDbUser(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    activeMode: 'client',
    platformRole: 'user',
    onboardingCompleted: true,
    deletedAt: null,
    expertProfileId: null,
    ...overrides,
  };
}

function getRedirectLocation(response: Response): string {
  return (
    new URL(response.headers.get('Location')!).pathname +
    new URL(response.headers.get('Location')!).search
  );
}

// ── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadWorkspaceDerivationMaterials.mockResolvedValue(materials());
  mockUpdate.mockResolvedValue({});
});

describe('GET /api/auth/session-sync', () => {
  describe('no session', () => {
    it('redirects to /login when session has no user', async () => {
      mockGetSession.mockResolvedValue({ user: undefined, save: vi.fn(), destroy: vi.fn() });

      const response = await GET(makeRequest('returnTo=/dashboard'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/login');
    });

    it('redirects to /login when session is null-ish', async () => {
      mockGetSession.mockResolvedValue({ save: vi.fn(), destroy: vi.fn() });

      const response = await GET(makeRequest());

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/login');
    });
  });

  describe('user not found in DB', () => {
    it('destroys session and redirects to /login with error', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(undefined);

      const response = await GET(makeRequest('returnTo=/dashboard'));

      expect(session.destroy).toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/login?error=account_deleted');
    });
  });

  describe('deleted user', () => {
    it('destroys session and redirects to /login with account_deleted error', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ deletedAt: new Date('2025-06-01') }));

      const response = await GET(makeRequest('returnTo=/settings'));

      expect(session.destroy).toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/login?error=account_deleted');
    });
  });

  describe('suspended user', () => {
    it('destroys session and redirects to /login with account_suspended error', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ status: 'suspended' }));

      const response = await GET(makeRequest('returnTo=/dashboard'));

      expect(session.destroy).toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/login?error=account_suspended');
    });

    it('destroys session for inactive users too', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ status: 'inactive' }));

      const response = await GET(makeRequest());

      expect(session.destroy).toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/login?error=account_suspended');
    });
  });

  describe('successful sync', () => {
    it('patches session fields and redirects to returnTo', async () => {
      const session = createMockSession({
        activeMode: 'client',
        platformRole: 'user',
        onboardingCompleted: false,
        expertProfileId: undefined,
      });
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(
        createDbUser({
          activeMode: 'expert',
          platformRole: 'admin',
          onboardingCompleted: true,
          expertProfileId: 'ep-789',
        })
      );
      // This user genuinely holds an approved expert profile (unlike the beforeEach
      // default), so no BAL-494 repair-demotion fires and activeMode stays 'expert'.
      mockLoadWorkspaceDerivationMaterials.mockResolvedValue(expertModeMaterials(true));

      const response = await GET(makeRequest('returnTo=/settings'));

      expect(session.user.activeMode).toBe('expert');
      expect(session.user.platformRole).toBe('admin');
      expect(session.user.onboardingCompleted).toBe(true);
      expect(session.user.expertProfileId).toBe('ep-789');
      expect(session.save).toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/settings');
    });

    it('sets expertProfileId to undefined when DB value is null', async () => {
      const session = createMockSession({ expertProfileId: 'ep-old' });
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ expertProfileId: null }));

      const response = await GET(makeRequest('returnTo=/dashboard'));

      expect(session.user.expertProfileId).toBeUndefined();
      expect(session.save).toHaveBeenCalled();
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });
  });

  describe('returnTo handling', () => {
    it('defaults to /dashboard when returnTo is missing', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest());

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });

    it('defaults to /dashboard when returnTo is empty string', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo='));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });

    it('rejects absolute URL returnTo (open redirect)', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=https://evil.com'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });

    it('rejects protocol-relative returnTo', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=//evil.com'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });

    it('allows same-origin path with colon (not a real redirect)', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=/foo://bar'));

      // URL parsing confirms this is a same-origin path, not an open redirect
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/foo://bar');
    });

    it('rejects returnTo pointing to /login', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=/login'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });

    it('rejects returnTo pointing to /signup', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=/signup'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/dashboard');
    });

    it('normalizes backslash in returnTo to forward slash', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=/foo\\bar'));

      // URL parsing normalizes backslash to forward slash — safe same-origin path
      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/foo/bar');
    });

    it('accepts valid relative path returnTo', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());

      const response = await GET(makeRequest('returnTo=/projects/123'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/projects/123');
    });
  });

  describe('BAL-494 / ADR-1053 — workspace repopulation + repair', () => {
    it('repopulates activeWorkspace on the session — and does NOT seal the list', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());
      mockLoadWorkspaceDerivationMaterials.mockResolvedValue(materials());

      await GET(makeRequest('returnTo=/dashboard'));

      expect(session.user.activeWorkspace).toEqual(COMPANY_WORKSPACE);
      // The cookie's hard 4096-byte limit is crossed at five to eight company workspaces and an
      // oversized `Set-Cookie` is silently discarded — so the sync route repopulates the
      // POINTER only. See `lib/auth/session-cookie-size.test.ts`.
      expect(session.user).not.toHaveProperty('workspaces');
    });

    it('demotes activeMode to client in the DB EXACTLY ONCE when the expert workspace vanished', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ activeMode: 'expert' }));
      mockLoadWorkspaceDerivationMaterials.mockResolvedValue(expertModeMaterials(false));

      await GET(makeRequest('returnTo=/dashboard'));

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenCalledWith(session.user.id, { activeMode: 'client' });
      expect(mockLogInfo).toHaveBeenCalledWith(
        'Workspace repair: activeMode demoted to client',
        expect.objectContaining({ userId: session.user.id })
      );
      expect(session.user.activeMode).toBe('client');
      expect(session.user.activeWorkspace).toEqual(COMPANY_WORKSPACE);
    });

    it('does NOT write to the DB when the expert workspace still exists', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ activeMode: 'expert' }));
      mockLoadWorkspaceDerivationMaterials.mockResolvedValue(expertModeMaterials(true));

      await GET(makeRequest('returnTo=/dashboard'));

      expect(mockUpdate).not.toHaveBeenCalled();
      expect(session.user.activeMode).toBe('expert');
      expect(session.user.activeWorkspace).toEqual(EXPERT_WORKSPACE);
    });

    it('still redirects to the safe returnTo after a repair write', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ activeMode: 'expert' }));
      mockLoadWorkspaceDerivationMaterials.mockResolvedValue(expertModeMaterials(false));

      const response = await GET(makeRequest('returnTo=/projects/123'));

      expect(response.status).toBe(307);
      expect(getRedirectLocation(response)).toBe('/projects/123');
    });

    it('leaves workspace fields absent (no crash) when the derivation resolves null', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser());
      mockLoadWorkspaceDerivationMaterials.mockResolvedValue(
        materials({
          input: {
            hasApprovedExpertProfile: false,
            memberships: [],
            eligibleCompanyIds: [],
            representedCompanies: [],
          },
        })
      );

      const response = await GET(makeRequest('returnTo=/dashboard'));

      expect(response.status).toBe(307);
      expect(session.user.activeWorkspace).toBeUndefined();
    });
  });
});
