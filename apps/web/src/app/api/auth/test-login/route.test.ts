import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { log } from '@/lib/logging';

// ── Mocks ───────────────────────────────────────────────────────

const {
  mockFindByEmail,
  mockUpdate,
  mockFindWithCompany,
  mockCreateWithWorkspace,
  mockSave,
  mockGetSession,
  mockFindForSessionSync,
  mockDeriveWorkspacesForUser,
  fakeSession,
} = vi.hoisted(() => {
  const save = vi.fn();
  const session: { user?: unknown; save: () => void } = { save };
  return {
    mockFindByEmail: vi.fn(),
    mockUpdate: vi.fn(),
    mockFindWithCompany: vi.fn(),
    mockCreateWithWorkspace: vi.fn(),
    mockSave: save,
    mockGetSession: vi.fn(),
    mockFindForSessionSync: vi.fn(),
    mockDeriveWorkspacesForUser: vi.fn(),
    fakeSession: session,
  };
});

vi.mock('@balo/db', () => ({
  usersRepository: {
    findByEmail: mockFindByEmail,
    update: mockUpdate,
    findWithCompany: mockFindWithCompany,
    createWithWorkspace: mockCreateWithWorkspace,
    // BAL-548 fix — `checkSessionDrift` (exercised by the "not drifted at birth" suite at the
    // bottom of this file) reads the row through this method, not `findByEmail`.
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
  },
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: mockGetSession,
}));

// BAL-494 — the workspace hydration seam the route now shares with `api/auth/callback`. Same
// mock shape as `callback/route.test.ts` and `lib/auth/session-sync.test.ts`; `checkSessionDrift`
// reads it through the SAME mock, which is what lets the two halves be compared below.
vi.mock('@/lib/workspaces/derive-workspaces', () => ({
  deriveWorkspacesForUser: (...args: unknown[]) => mockDeriveWorkspacesForUser(...args),
}));

import { POST, PERSONA_PLATFORM_ROLE } from './route';
import { checkSessionDrift } from '@/lib/auth/session-sync';

// ── Helpers ─────────────────────────────────────────────────────

const TEST_SECRET = 'e2e-test-secret-value-at-least-32-chars-long';

function makeRequest(body: unknown, secret?: string | null): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret != null) headers['x-e2e-secret'] = secret;
  return new NextRequest('http://localhost:3000/api/auth/test-login', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function enableSecret(): void {
  vi.stubEnv('E2E_TEST_SECRET', TEST_SECRET);
}

interface UserRowOverrides {
  id?: string;
  platformRole?: 'user' | 'admin' | 'super_admin';
  onboardingCompleted?: boolean;
}

function userRow(overrides: UserRowOverrides = {}): Record<string, unknown> {
  return {
    id: 'user-1',
    email: 'unonboarded-e2e@balo.test',
    firstName: 'E2E',
    lastName: 'Test',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: false,
    platformRole: 'user',
    ...overrides,
  };
}

const membershipRow = { role: 'owner', company: { id: 'company-1', name: 'Workspace' } };

function mintedRole(): unknown {
  return (fakeSession.user as { platformRole?: string } | undefined)?.platformRole;
}

// ── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  fakeSession.user = undefined;
  mockGetSession.mockResolvedValue(fakeSession);
  // Default `null` (no company workspace derivable) so every pre-existing test's minted
  // `SessionUser` shape is byte-identical to before the BAL-548 hydration fix; the
  // "not drifted at birth" suite below opts IN to a real derivation. Same default as
  // `callback/route.test.ts`.
  mockDeriveWorkspacesForUser.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/auth/test-login — secret gate, deployment-agnostic', () => {
  it('returns 404 when E2E_TEST_SECRET is unset (NODE_ENV=development, proves not dev-gated)', async () => {
    vi.stubEnv('E2E_TEST_SECRET', '');
    vi.stubEnv('NODE_ENV', 'development');
    const res = await POST(makeRequest({ onboardingCompleted: false }, TEST_SECRET));
    expect(res.status).toBe(404);
    expect(mockFindByEmail).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('returns 404 when E2E_TEST_SECRET is unset (NODE_ENV=production)', async () => {
    vi.stubEnv('E2E_TEST_SECRET', '');
    vi.stubEnv('NODE_ENV', 'production');
    const res = await POST(makeRequest({ onboardingCompleted: false }, TEST_SECRET));
    expect(res.status).toBe(404);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('returns 200 with a valid secret even when NODE_ENV=production (NODE_ENV-independent)', async () => {
    enableSecret();
    vi.stubEnv('NODE_ENV', 'production');
    mockFindByEmail.mockResolvedValue(userRow({ platformRole: 'user' }));
    mockUpdate.mockResolvedValue(userRow({ platformRole: 'user', onboardingCompleted: true }));
    mockFindWithCompany.mockResolvedValue({ companyMemberships: [membershipRow] });

    const res = await POST(makeRequest({ onboardingCompleted: true }, TEST_SECRET));

    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mintedRole()).toBe('user');
  });

  it('returns 401 when the x-e2e-secret header is missing', async () => {
    enableSecret();
    const res = await POST(makeRequest({ onboardingCompleted: false }));
    expect(res.status).toBe(401);
    expect(mockFindByEmail).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('returns 401 for a wrong secret of the same length (timing-safe path)', async () => {
    enableSecret();
    const wrongSameLength = 'X'.repeat(TEST_SECRET.length);
    const res = await POST(makeRequest({ onboardingCompleted: false }, wrongSameLength));
    expect(res.status).toBe(401);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('returns 401 for a wrong secret of a different length without throwing', async () => {
    enableSecret();
    const res = await POST(makeRequest({ onboardingCompleted: false }, 'x'));
    expect(res.status).toBe(401);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/test-login — validation', () => {
  it('returns 400 for an invalid body', async () => {
    enableSecret();
    const res = await POST(makeRequest({ onboardingCompleted: 'nope' }, TEST_SECRET));
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/test-login — session minting', () => {
  it('updates an existing plain-user row and mints a user session', async () => {
    enableSecret();
    mockFindByEmail.mockResolvedValue(userRow({ platformRole: 'user' }));
    mockUpdate.mockResolvedValue(userRow({ platformRole: 'user', onboardingCompleted: true }));
    mockFindWithCompany.mockResolvedValue({ companyMemberships: [membershipRow] });

    const res = await POST(makeRequest({ onboardingCompleted: true }, TEST_SECRET));

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith('user-1', { onboardingCompleted: true });
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mintedRole()).toBe('user');
  });

  it('creates a new workspace-backed test user when none exists', async () => {
    enableSecret();
    mockFindByEmail.mockResolvedValue(undefined);
    mockCreateWithWorkspace.mockResolvedValue({
      user: userRow({ platformRole: 'user' }),
      company: { id: 'company-1', name: 'Workspace' },
      membership: { role: 'owner' },
    });

    const res = await POST(makeRequest({ onboardingCompleted: false }, TEST_SECRET));

    expect(res.status).toBe(200);
    expect(mockCreateWithWorkspace).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mintedRole()).toBe('user');
  });

  it('refuses (400) and never mints a session when the derived row is elevated', async () => {
    enableSecret();
    mockFindByEmail.mockResolvedValue(userRow({ platformRole: 'admin' }));

    const res = await POST(makeRequest({ onboardingCompleted: false }, TEST_SECRET));

    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(fakeSession.user).toBeUndefined();
  });

  it('returns 500 and logs when the repository throws', async () => {
    enableSecret();
    mockFindByEmail.mockRejectedValue(new Error('boom'));

    const res = await POST(makeRequest({ onboardingCompleted: false }, TEST_SECRET));

    expect(res.status).toBe(500);
    expect(mockSave).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });
});

// ── BAL-548: the closed `persona` seam ─────────────────────────

describe('POST /api/auth/test-login — persona seam (BAL-548)', () => {
  it('returns 404 when E2E_TEST_SECRET is unset — even for persona: "staff"', async () => {
    vi.stubEnv('E2E_TEST_SECRET', '');
    const res = await POST(makeRequest({ persona: 'staff' }, TEST_SECRET));
    expect(res.status).toBe(404);
    expect(mockFindByEmail).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(fakeSession.user).toBeUndefined();
  });

  it('returns 401 when the x-e2e-secret header is wrong — even for persona: "staff"', async () => {
    enableSecret();
    const wrongSameLength = 'X'.repeat(TEST_SECRET.length);
    const res = await POST(makeRequest({ persona: 'staff' }, wrongSameLength));
    expect(res.status).toBe(401);
    expect(mockFindByEmail).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(fakeSession.user).toBeUndefined();
  });

  it('persona "staff" mints exactly platformRole "admin" and never "super_admin"', async () => {
    enableSecret();

    // Arm 1: existing staff row already matches — plain update, no role write.
    mockFindByEmail.mockResolvedValue(userRow({ platformRole: 'admin' }));
    mockUpdate.mockResolvedValue(userRow({ platformRole: 'admin', onboardingCompleted: true }));
    mockFindWithCompany.mockResolvedValue({ companyMemberships: [membershipRow] });

    const res1 = await POST(
      makeRequest({ onboardingCompleted: true, persona: 'staff' }, TEST_SECRET)
    );

    expect(res1.status).toBe(200);
    // BAL-548 F2: exact match, not a `-e2e@balo.test$` regex — that regex also matches the
    // member personas' derived addresses, so it cannot actually pin the staff persona to
    // STAFF_EMAIL. This is the assertion that fails if `deriveTestEmail` ever collapses the
    // two personas onto one address.
    expect(mockFindByEmail).toHaveBeenCalledWith('staff-e2e@balo.test');
    expect(mintedRole()).toBe('admin');
    expect(mintedRole()).not.toBe('super_admin');

    // Arm 2: brand-new account — createWithWorkspace mints a plain 'user' row, so the route
    // must follow up with an explicit platformRole update to 'admin'.
    vi.clearAllMocks();
    fakeSession.user = undefined;
    mockGetSession.mockResolvedValue(fakeSession);
    enableSecret();
    mockFindByEmail.mockResolvedValue(undefined);
    mockCreateWithWorkspace.mockResolvedValue({
      user: userRow({ id: 'created-1', platformRole: 'user' }),
      company: { id: 'company-1', name: 'Workspace' },
      membership: { role: 'owner' },
    });
    mockUpdate.mockResolvedValue(userRow({ id: 'created-1', platformRole: 'admin' }));

    const res2 = await POST(makeRequest({ persona: 'staff' }, TEST_SECRET));

    expect(res2.status).toBe(200);
    // BAL-548 F2: same exact-match pin as arm 1, for the create branch.
    expect(mockFindByEmail).toHaveBeenCalledWith('staff-e2e@balo.test');
    expect(mockUpdate).toHaveBeenCalledWith('created-1', { platformRole: 'admin' });
    expect(mintedRole()).toBe('admin');
    expect(mintedRole()).not.toBe('super_admin');
  });

  it('mints the role from the CLOSED persona map, never from a lying row (BAL-548 F1)', async () => {
    enableSecret();

    // The refusal check passes (existing row is 'admin', matching persona 'staff'), but the
    // MUTATION that follows returns a row claiming 'super_admin' — a lying database, standing
    // in for e.g. a stale read or a concurrent write racing the update. If the session-minting
    // code ever reads `resolved.user.platformRole` (the row) instead of
    // `PERSONA_PLATFORM_ROLE[persona]` (the constant), this test mints 'super_admin' and fails.
    mockFindByEmail.mockResolvedValue(userRow({ platformRole: 'admin' }));
    mockUpdate.mockResolvedValue(
      userRow({ platformRole: 'super_admin', onboardingCompleted: true })
    );
    mockFindWithCompany.mockResolvedValue({ companyMemberships: [membershipRow] });

    const res = await POST(
      makeRequest({ onboardingCompleted: true, persona: 'staff' }, TEST_SECRET)
    );

    expect(res.status).toBe(200);
    expect(mintedRole()).toBe('admin');
    expect(mintedRole()).not.toBe('super_admin');
  });

  it('the member persona still mints platformRole "user" (and is the default when persona is omitted)', async () => {
    enableSecret();

    // Arm 1: no persona in the body at all — defaults to 'member'.
    mockFindByEmail.mockResolvedValue(userRow({ platformRole: 'user' }));
    mockUpdate.mockResolvedValue(userRow({ platformRole: 'user', onboardingCompleted: true }));
    mockFindWithCompany.mockResolvedValue({ companyMemberships: [membershipRow] });

    const res1 = await POST(makeRequest({ onboardingCompleted: true }, TEST_SECRET));

    expect(res1.status).toBe(200);
    expect(mintedRole()).toBe('user');
    // BAL-548 F2: exact match (not the `-e2e@balo.test$` regex, which also matches
    // `staff-e2e@balo.test` and so cannot distinguish the personas), and no unchecked
    // `as [string]` index cast (house rule: destructure + guard).
    expect(mockFindByEmail).toHaveBeenCalledWith('onboarded-e2e@balo.test');

    // Arm 2: explicit persona: 'member'.
    vi.clearAllMocks();
    fakeSession.user = undefined;
    mockGetSession.mockResolvedValue(fakeSession);
    enableSecret();
    mockFindByEmail.mockResolvedValue(userRow({ platformRole: 'user' }));
    mockUpdate.mockResolvedValue(userRow({ platformRole: 'user' }));
    mockFindWithCompany.mockResolvedValue({ companyMemberships: [membershipRow] });

    const res2 = await POST(makeRequest({ persona: 'member' }, TEST_SECRET));

    expect(res2.status).toBe(200);
    expect(mintedRole()).toBe('user');
    // BAL-548 F2: exact match — onboardingCompleted defaults to false here, so this is the
    // 'unonboarded' address, distinct from arm 1's 'onboarded' address.
    expect(mockFindByEmail).toHaveBeenCalledWith('unonboarded-e2e@balo.test');
  });

  it('rejects a body carrying an email or a role field (the schema is .strict())', async () => {
    enableSecret();

    // This is the test that would FAIL without `.strict()` on the schema — a bare
    // `z.object()` strips unknown keys instead of rejecting them.
    const res1 = await POST(
      makeRequest({ onboardingCompleted: true, email: 'x@y.z' }, TEST_SECRET)
    );
    expect(res1.status).toBe(400);

    const res2 = await POST(
      makeRequest({ onboardingCompleted: true, platformRole: 'super_admin' }, TEST_SECRET)
    );
    expect(res2.status).toBe(400);

    const res3 = await POST(makeRequest({ persona: 'root' }, TEST_SECRET));
    expect(res3.status).toBe(400);

    expect(mockFindByEmail).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('refuses before mutating when the existing row does not match the persona', async () => {
    enableSecret();

    // (a) persona: 'staff' but the existing row is a plain member — must not be elevated.
    mockFindByEmail.mockResolvedValue(userRow({ platformRole: 'user' }));
    const resA = await POST(makeRequest({ persona: 'staff' }, TEST_SECRET));
    expect(resA.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(fakeSession.user).toBeUndefined();

    // (b) persona: 'member' but the existing row is admin — the pre-existing behaviour,
    // re-pinned under the generalised check.
    vi.clearAllMocks();
    fakeSession.user = undefined;
    mockGetSession.mockResolvedValue(fakeSession);
    enableSecret();
    mockFindByEmail.mockResolvedValue(userRow({ platformRole: 'admin' }));
    const resB = await POST(makeRequest({ persona: 'member' }, TEST_SECRET));
    expect(resB.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(fakeSession.user).toBeUndefined();
  });

  it('the persona map is the entire mintable role space and contains no super_admin', () => {
    // BAL-548 F4: enumerate the EXPORTED map, not the two personas this test already knows
    // about — adding a third persona (e.g. `root: 'super_admin'`) to `TEST_PERSONAS` +
    // `PERSONA_PLATFORM_ROLE` + the schema's `z.enum` fails this test even though nothing
    // above it changes, because it is reading the map's actual key/value set back.
    expect(Object.keys(PERSONA_PLATFORM_ROLE).sort()).toEqual(['member', 'staff']);
    expect(new Set(Object.values(PERSONA_PLATFORM_ROLE))).toEqual(new Set(['user', 'admin']));
    expect(Object.values(PERSONA_PLATFORM_ROLE)).not.toContain('super_admin');
  });
});

/**
 * ⚠⚠ BAL-548 — THE SEEDED SESSION MUST NOT BE DRIFTED THE INSTANT IT IS SEALED.
 *
 * This suite exists because every OTHER test in this file passed while CI's E2E job was red.
 * They all assert what the route PUTS in the session; none asked whether the app ACCEPTS that
 * session. It does not, if `activeWorkspace` is missing: `checkSessionDrift` classifies an
 * absent pointer as the pre-BAL-494 bootstrap case and returns `sync-needed`, so
 * `(dashboard)/layout.tsx` burns the first navigation after `seedSession()` on a
 * `/api/auth/session-sync` round-trip that lands on `/dashboard` (that layout's `returnTo` reads
 * `headers().get('x-invoke-path')`, a header which does not exist in Next 16, so it always falls
 * back to `/dashboard`). Three staff arms of `e2e/admin-shell.spec.ts` therefore landed on
 * `/dashboard` and read as a broken `VIEW_PLATFORM_ADMIN` gate — while the sealed cookie had
 * carried `platformRole: 'admin'` correctly the whole time.
 *
 * ⚠ IT IS DELIBERATELY A CROSS-SEAM TEST, AND THAT IS THE POINT. It runs the REAL
 * `checkSessionDrift` against the REAL session object the REAL `POST` just wrote, through the
 * one `deriveWorkspacesForUser` mock both halves read. A test that only asserted
 * "`activeWorkspace` is set" would pin the SYMPTOM, and could be satisfied by a hand-rolled
 * literal that forks the projection rule; this one pins the CONTRACT — a session this route
 * mints is one the app will not immediately bounce — so it also fails for any future field the
 * drift gate learns to compare.
 */
describe('POST /api/auth/test-login — the seeded session is not drifted at birth (BAL-548)', () => {
  const COMPANY_WORKSPACE = {
    type: 'company' as const,
    key: 'company:company-1',
    companyId: 'company-1',
    name: 'Workspace',
    via: 'membership' as const,
    isPersonal: false,
  };

  /** What `deriveWorkspacesForUser` yields for the personal workspace `membershipRow` describes. */
  function derivation() {
    return {
      workspaces: [COMPANY_WORKSPACE],
      activeWorkspace: COMPANY_WORKSPACE,
      session: {
        activeMode: 'client' as const,
        companyId: 'company-1',
        companyName: 'Workspace',
        companyRole: 'owner' as const,
      },
    };
  }

  /** The `findForSessionSync` projection of the same row — what the drift gate compares against. */
  function sessionSyncRow(platformRole: 'user' | 'admin') {
    return {
      status: 'active',
      activeMode: 'client',
      platformRole,
      onboardingCompleted: true,
      deletedAt: null,
      expertProfileId: null,
      activeCompanyId: 'company-1',
      expertApprovedAt: null,
      verticalId: null,
    };
  }

  function arrange(expectedRole: 'user' | 'admin'): void {
    enableSecret();
    mockDeriveWorkspacesForUser.mockResolvedValue(derivation());
    mockFindByEmail.mockResolvedValue(userRow({ platformRole: expectedRole }));
    mockUpdate.mockResolvedValue(
      userRow({ platformRole: expectedRole, onboardingCompleted: true })
    );
    mockFindWithCompany.mockResolvedValue({ companyMemberships: [membershipRow] });
  }

  it.each([
    ['staff', 'admin'],
    ['member', 'user'],
  ] as const)(
    'persona "%s" seals a session checkSessionDrift accepts — no sync round-trip',
    async (persona, expectedRole) => {
      arrange(expectedRole);

      const res = await POST(makeRequest({ onboardingCompleted: true, persona }, TEST_SECRET));
      expect(res.status).toBe(200);
      expect(mintedRole()).toBe(expectedRole);

      // ── The half that was missing. The route sealed a session; now ask the app about it. ──
      mockFindForSessionSync.mockResolvedValue(sessionSyncRow(expectedRole));

      // `checkSessionDrift` reads the session through the SAME mocked `getSession`, so it sees
      // exactly the object `POST` just wrote — no re-derivation, no hand-built fixture.
      await expect(checkSessionDrift()).resolves.toEqual({ action: 'ok' });
    }
  );

  it('routes the hydration through applyWorkspaceDerivationToSessionUser, not a hand-rolled literal', async () => {
    // The pointer is a NARROW projection of the full `Workspace` (BAL-507): `via` and
    // `isPersonal` are dropped. Pinning the exact key set is what stops a future edit assigning
    // `derived.activeWorkspace` raw — structurally assignable, so the compiler would not object,
    // and it would re-inflate the 4096-byte cookie budget `session-cookie-size.test.ts` guards.
    arrange('admin');

    await POST(makeRequest({ onboardingCompleted: true, persona: 'staff' }, TEST_SECRET));

    const user = fakeSession.user as { activeWorkspace?: Record<string, unknown> };
    expect(user.activeWorkspace).toBeDefined();
    expect(Object.keys(user.activeWorkspace ?? {}).sort()).toEqual([
      'companyId',
      'key',
      'name',
      'type',
    ]);
  });
});
