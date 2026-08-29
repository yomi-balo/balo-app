import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
  },
}));

const mockGetSession = vi.fn();
vi.mock('./session', () => ({
  getSession: () => mockGetSession(),
}));

const mockDeriveWorkspacesForUser = vi.fn();
vi.mock('@/lib/workspaces/derive-workspaces', () => ({
  deriveWorkspacesForUser: (...args: unknown[]) => mockDeriveWorkspacesForUser(...args),
}));

import { checkSessionDrift } from './session-sync';

// ── Helpers ─────────────────────────────────────────────────────

const COMPANY_WORKSPACE = {
  type: 'company' as const,
  key: 'company:company-1',
  companyId: 'company-1',
  name: 'Test Company',
  via: 'membership' as const,
  isPersonal: false,
};

function derivedWorkspaces(overrides: Record<string, unknown> = {}) {
  return {
    workspaces: [COMPANY_WORKSPACE],
    activeWorkspace: COMPANY_WORKSPACE,
    session: {
      activeMode: 'client',
      companyId: 'company-1',
      companyName: 'Test Company',
      companyRole: 'owner',
    },
    ...overrides,
  };
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
      // The POINTER only — the full list is never sealed into the cookie (4096-byte browser
      // limit; see `lib/auth/session-cookie-size.test.ts`), it is derived per request.
      activeWorkspace: COMPANY_WORKSPACE,
      ...userOverrides,
    },
    save: vi.fn(),
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

// ── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the derivation matches the default session's workspace exactly, so every
  // pre-existing (pre-BAL-494) test case stays 'ok' unless it deliberately overrides this.
  mockDeriveWorkspacesForUser.mockResolvedValue(derivedWorkspaces());
});

describe('checkSessionDrift', () => {
  // 1. No session → sync-needed
  it('returns sync-needed when there is no session user', async () => {
    mockGetSession.mockResolvedValue({ user: undefined });

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 2. User not found in DB → sync-needed
  it('returns sync-needed when user not found in DB', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(undefined);

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
    // Read-only: no session mutation
    expect(session.destroy).not.toHaveBeenCalled();
    expect(session.save).not.toHaveBeenCalled();
  });

  // 3. User soft-deleted → sync-needed
  it('returns sync-needed when user is soft-deleted', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ deletedAt: new Date('2025-01-01') }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 4. User suspended → sync-needed
  it('returns sync-needed when user status is suspended', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ status: 'suspended' }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 5. User inactive → sync-needed
  it('returns sync-needed when user status is inactive', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ status: 'inactive' }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 6. No drift → ok
  it('returns ok when session matches DB', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'ok' });
    expect(session.save).not.toHaveBeenCalled();
  });

  // 7. activeMode drift → sync-needed
  it('returns sync-needed when activeMode drifts', async () => {
    const session = createMockSession({ activeMode: 'client' });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ activeMode: 'expert' }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 8. platformRole drift → sync-needed
  it('returns sync-needed when platformRole drifts', async () => {
    const session = createMockSession({ platformRole: 'user' });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ platformRole: 'admin' }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 9. onboardingCompleted drift → sync-needed
  it('returns sync-needed when onboardingCompleted drifts', async () => {
    const session = createMockSession({ onboardingCompleted: false });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ onboardingCompleted: true }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 10. expertProfileId drift → sync-needed
  it('returns sync-needed when expertProfileId drifts', async () => {
    const session = createMockSession({ expertProfileId: 'ep-123' });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ expertProfileId: null }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 11. Multiple fields drift → sync-needed
  it('returns sync-needed when multiple fields drift', async () => {
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
        expertProfileId: 'ep-456',
      })
    );

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
    // Read-only: session NOT mutated
    expect(session.user.activeMode).toBe('client');
    expect(session.save).not.toHaveBeenCalled();
  });

  // 12. expertProfileId: DB null matches session undefined → ok
  it('returns ok when expertProfileId is null in DB and undefined in session', async () => {
    const session = createMockSession({ expertProfileId: undefined });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ expertProfileId: null }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'ok' });
  });
});

describe('checkSessionDrift — BAL-494 workspace drift', () => {
  // 1. Bootstrap: absent activeWorkspace ⇒ derive FIRST, then decide.
  it('returns sync-needed when activeWorkspace is absent (pre-BAL-494 cookie) and a workspace IS derivable', async () => {
    const session = createMockSession({ activeWorkspace: undefined });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
    expect(mockDeriveWorkspacesForUser).toHaveBeenCalledWith('user-1');
  });

  // 1b. ⚠ THE LOCKOUT REGRESSION. An ACTIVE user with zero live company memberships derives
  //     `null`, and the sync route only populates the workspace fields when the derivation is
  //     non-null. If the bootstrap arm short-circuited to 'sync-needed' before deriving, this
  //     user would bounce layout → sync → still undefined → layout … unbounded. "No derivable
  //     workspace" must be a STABLE state.
  it('returns ok when activeWorkspace is absent AND no workspace is derivable (no redirect loop)', async () => {
    const session = createMockSession({ activeWorkspace: undefined });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(null);

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'ok' });
  });

  // 2. The active workspace's key is no longer in the derived list.
  it('returns sync-needed when the active workspace has fallen out of the derived list', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(
      derivedWorkspaces({
        workspaces: [{ ...COMPANY_WORKSPACE, key: 'company:other', companyId: 'other' }],
        activeWorkspace: { ...COMPANY_WORKSPACE, key: 'company:other', companyId: 'other' },
      })
    );

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 3. ⚠ THE DELETED CHECK. An earlier cut compared the session's cached workspace KEY SET
  //    against the freshly derived one. That existed only to keep a COOKIE-CACHED list fresh,
  //    and the list is no longer in the cookie — it overran the browser's 4096-byte limit at
  //    five to eight company workspaces, at which point the browser silently discards the
  //    `Set-Cookie` and the user is locked out with no server-side error
  //    (see `lib/auth/session-cookie-size.test.ts`). With the list always derived fresh there
  //    is nothing stale to detect, and a gratuitous 'sync-needed' here would be a wasted
  //    redirect on every render for a user who simply gained a workspace.
  it('returns ok when the derived list GREW but the active workspace and projection are unchanged', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());
    const EXPERT_WORKSPACE = { type: 'expert' as const, key: 'expert' };
    mockDeriveWorkspacesForUser.mockResolvedValue(
      derivedWorkspaces({ workspaces: [COMPANY_WORKSPACE, EXPERT_WORKSPACE] })
    );

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'ok' });
  });

  // 3b. The list SHRINKING is still caught — but by check (2)/(4), on the axis that matters:
  //     losing a workspace you are NOT acting as changes no authorization input, while losing
  //     the one you ARE acting as moves the resolved active workspace and its projection.
  it('returns ok when the derived list SHRANK without touching the active workspace', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());
    // The session was minted when the user also held `company-2`; it is gone now. The active
    // workspace, its key and the whole projection are identical, so nothing authz-relevant
    // moved — and the derivation below simply no longer lists the departed company.
    mockDeriveWorkspacesForUser.mockResolvedValue(
      derivedWorkspaces({ workspaces: [COMPANY_WORKSPACE] })
    );

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'ok' });
  });

  // 4. The projection invariant: derived.session.activeMode disagrees with session.activeMode.
  it('returns sync-needed when the derived projection activeMode disagrees with the session', async () => {
    const session = createMockSession({ activeMode: 'client' });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ activeMode: 'client' }));
    mockDeriveWorkspacesForUser.mockResolvedValue(
      derivedWorkspaces({ session: { ...derivedWorkspaces().session, activeMode: 'expert' } })
    );

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 4b. THE RESOLVED ACTIVE WORKSPACE differs — the cross-device case. Device 1 switched to
  //     company B; device 2's 7-day cookie still names A, and A is still in the list, so the
  //     `stillListed` check alone is blind to it. Only this comparison makes AC (a)'s
  //     "persists across devices" true after login as well as at login.
  it('returns sync-needed when the DERIVED active workspace differs (device 1 switched, device 2 is stale)', async () => {
    const OTHER_WORKSPACE = {
      ...COMPANY_WORKSPACE,
      key: 'company:company-2',
      companyId: 'company-2',
      name: 'Other Company',
    };
    const session = createMockSession({ activeWorkspace: COMPANY_WORKSPACE });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(
      derivedWorkspaces({
        workspaces: [COMPANY_WORKSPACE, OTHER_WORKSPACE],
        activeWorkspace: OTHER_WORKSPACE,
        session: {
          activeMode: 'client',
          companyId: 'company-2',
          companyName: 'Other Company',
          companyRole: 'owner',
        },
      })
    );

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 4c. The `via` blind spot. A key does NOT encode `via`, so a member who also holds an
  //     org-scope representation for the SAME company and then loses membership stays
  //     `stillListed` — while the derivation has already re-resolved elsewhere, leaving a
  //     stale `companyId` feeding `resolve-request-lens.ts`. R1 keeps a representation
  //     workspace un-activatable, so the derived active workspace moves and this fires.
  it('returns sync-needed when membership flips to representation-only for the active company', async () => {
    const REP_WORKSPACE = { ...COMPANY_WORKSPACE, via: 'representation' as const };
    const FALLBACK_WORKSPACE = {
      ...COMPANY_WORKSPACE,
      key: 'company:company-personal',
      companyId: 'company-personal',
      name: 'Personal Workspace',
      isPersonal: true,
    };
    const session = createMockSession({ activeWorkspace: COMPANY_WORKSPACE });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(
      derivedWorkspaces({
        // Same KEY, now held only by representation — so it can never be the active one.
        workspaces: [FALLBACK_WORKSPACE, REP_WORKSPACE],
        activeWorkspace: FALLBACK_WORKSPACE,
        session: {
          activeMode: 'client',
          companyId: 'company-personal',
          companyName: 'Personal Workspace',
          companyRole: 'owner',
        },
      })
    );

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 4d. The projection compares the WHOLE projection, not just `activeMode`: an owner →
  //     member demotion would otherwise sit in the cookie for the full 7 days.
  it('returns sync-needed when companyRole was demoted (owner → member)', async () => {
    const session = createMockSession({ companyRole: 'owner' });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(
      derivedWorkspaces({ session: { ...derivedWorkspaces().session, companyRole: 'member' } })
    );

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  it('returns sync-needed when the projected companyId disagrees with the session', async () => {
    const session = createMockSession({ companyId: 'company-stale' });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  it('returns sync-needed when the company was RENAMED (companyName drift)', async () => {
    const session = createMockSession({ companyName: 'Old Name' });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // 5. Fully consistent ⇒ ok.
  it('returns ok when the workspace, key set, and projection are all consistent', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(derivedWorkspaces());

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'ok' });
  });

  // 6. No company workspace at all (derivation returns null) ⇒ ok, workspace fields untouched.
  it('returns ok when deriveWorkspacesForUser resolves null (no company workspace at all)', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(null);

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'ok' });
  });
});
