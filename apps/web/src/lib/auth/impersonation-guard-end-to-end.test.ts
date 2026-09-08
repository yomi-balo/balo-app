import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * BAL-553 AC 3 — the end-to-end proof that the real START-IMPERSONATION path produces a session
 * the real BAL-528 guard actually refuses. A unit test that hand-sets `isImpersonating: true` on
 * a literal does NOT satisfy AC 3 — see ruling R9. This test never does that: every session it
 * inspects was produced by the real `startImpersonationAction` / `stopImpersonationAction`,
 * unsealed with the real password, through the real `iron-session` crypto.
 *
 * REAL (never mocked): `@/lib/auth/session`, `@/lib/auth/impersonation`,
 * `@/lib/auth/session-config`, `@/lib/auth/impersonation-preserved-session`,
 * `@/lib/auth/actions/impersonation`, `iron-session`, `@balo/shared/authz`,
 * `@/lib/authz/platform`, and `startContinueToMandate` (the action under test).
 *
 * MOCKED (leaves only): `next/headers` (a real in-memory cookie jar — this jar IS the browser),
 * `@balo/db` (repository reads only — no real Postgres), `@/lib/workspaces/derive-workspaces`
 * (a fixed derivation for the target), and `@/lib/logging` (auto-mocked globally by
 * `src/test/setup.ts` — `log.warn` is the oracle for the refusal).
 */

vi.mock('server-only', () => ({}));

const { TEST_PASSWORD } = vi.hoisted(() => {
  // `session-config.ts` reads `process.env.WORKOS_COOKIE_PASSWORD` at MODULE LOAD, so this must
  // run before the hoisted imports below — a `vi.hoisted` block does exactly that. Keeps the
  // REAL `impersonatedSessionConfig` in play, so the TTL assertions exercise the real seam.
  const password = 'bal-553-guard-e2e-test-password-0123456789abcdef';
  process.env.WORKOS_COOKIE_PASSWORD = password;
  return { TEST_PASSWORD: password };
});

// ── The in-memory cookie jar — this IS the browser. Hoisted so both the `next/headers` mock
// factory and the test bodies below can reach the SAME store. ──────────────────────────────────
interface StoredCookie {
  value: string;
  options?: Record<string, unknown>;
}
const jar = vi.hoisted(() => new Map<string, StoredCookie>());

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get(name: string): { name: string; value: string } | undefined {
        const c = jar.get(name);
        return c === undefined ? undefined : { name, value: c.value };
      },
      set(
        nameOrOptions: string | ({ name: string; value: string } & Record<string, unknown>),
        value?: string,
        options?: Record<string, unknown>
      ): void {
        if (typeof nameOrOptions === 'string') {
          jar.set(nameOrOptions, { value: value ?? '', options });
          return;
        }
        const { name, value: v, ...opts } = nameOrOptions;
        jar.set(name, { value: v, options: opts });
      },
      delete(name: string): void {
        jar.delete(name);
      },
      has(name: string): boolean {
        return jar.has(name);
      },
    }),
}));

// ── @balo/db — repository reads only, no real Postgres ────────────────────

const mockFindForSessionSync = vi.fn();
const mockFindById = vi.fn();
const mockAuditRecord = vi.fn();
const mockFindByCompanyId = vi.fn();
const mockGetMemberRole = vi.fn();
// F4 part 2 — the session-sync route's ONE DB write (the repair demotion).
const mockUsersUpdate = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...a: unknown[]) => mockFindForSessionSync(...(a as [string])),
    findById: (...a: unknown[]) => mockFindById(...(a as [string])),
    update: (...a: unknown[]) => mockUsersUpdate(...a),
  },
  auditEventsRepository: { record: (...a: unknown[]) => mockAuditRecord(...a) },
  creditWalletsRepository: { findByCompanyId: (...a: unknown[]) => mockFindByCompanyId(...a) },
  // `@/lib/authz`'s hasCapability (a REAL, unmocked module reached from startContinueToMandate)
  // needs this leaf so it resolves `false` instead of throwing on an undefined repository.
  partyMembershipsRepository: { getMemberRole: (...a: unknown[]) => mockGetMemberRole(...a) },
  db: {},
}));

const TARGET_COMPANY_ID = 'company-target-northwind';
const TARGET_DERIVATION = {
  workspaces: [],
  activeWorkspace: { type: 'company' as const, key: `company:${TARGET_COMPANY_ID}` },
  session: {
    activeMode: 'client' as const,
    companyId: TARGET_COMPANY_ID,
    companyName: 'Northwind Industrial',
    companyRole: 'owner' as const,
  },
};

// F4 part 2 — the session-sync route's OWN read half. Returns fixed materials the REAL
// `deriveWorkspaces` (from `@balo/shared/workspaces`, never mocked) turns into a derivation with
// NO expert workspace, so `dbUser.activeMode === 'expert'` (mocked per-test below) triggers the
// route's repair write.
const mockLoadWorkspaceDerivationMaterials = vi.fn();
vi.mock('@/lib/workspaces/derive-workspaces', () => ({
  deriveWorkspacesForUser: vi.fn(async (userId: string) =>
    userId === TARGET_ID ? TARGET_DERIVATION : null
  ),
  loadWorkspaceDerivationMaterials: (...a: unknown[]) => mockLoadWorkspaceDerivationMaterials(...a),
}));

// `revalidatePath` requires a real Next.js request's AsyncLocalStorage context ("static
// generation store"), which does not exist under plain Vitest — every other Server Action test
// in this repo mocks it the same way (e.g. `switch-workspace.test.ts`). A no-op leaf: this test
// is not about cache invalidation.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// ── Real modules under test ────────────────────────────────────────────────

import { unsealData } from 'iron-session';
import { getSession } from '@/lib/auth/session';
import type { SessionData, SessionUser } from '@/lib/auth/session';
import { COOKIE_NAME } from '@/lib/auth/session-config';
import { IMPERSONATION_REFUSAL_MESSAGE } from '@/lib/auth/impersonation';
import { PRESERVED_ADMIN_COOKIE } from '@/lib/auth/impersonation-preserved-session';
import {
  startImpersonationAction,
  stopImpersonationAction,
} from '@/lib/auth/actions/impersonation';
import { startContinueToMandate } from '@/app/(dashboard)/redeem/_actions/start-continue-to-mandate';
import { GET as sessionSyncGet } from '@/app/api/auth/session-sync/route';
import { NextRequest } from 'next/server';
import { log } from '@/lib/logging';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

const ADMIN_SESSION_USER: SessionUser = {
  id: ADMIN_ID,
  email: 'admin@balo.com',
  firstName: 'Ada',
  lastName: 'Admin',
  avatarUrl: null,
  activeMode: 'client',
  onboardingCompleted: true,
  platformRole: 'super_admin',
  companyId: 'company-balo-staff',
  companyName: 'Balo Staff',
  companyRole: 'owner',
};

function targetSyncRow(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    activeMode: 'client',
    platformRole: 'user',
    onboardingCompleted: true,
    deletedAt: null,
    expertProfileId: null,
    activeCompanyId: null,
    expertApprovedAt: null,
    verticalId: null,
    ...overrides,
  };
}

function adminSyncRow(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    activeMode: 'client',
    platformRole: 'super_admin',
    onboardingCompleted: true,
    deletedAt: null,
    expertProfileId: null,
    activeCompanyId: null,
    expertApprovedAt: null,
    verticalId: null,
    ...overrides,
  };
}

/** Real cookie options recorded by the fake `next/headers` jar for one cookie name. */
function jarOptionsOf(name: string): Record<string, unknown> | undefined {
  return jar.get(name)?.options;
}

async function seedAdminSession(): Promise<void> {
  const adminSession = await getSession();
  adminSession.user = { ...ADMIN_SESSION_USER };
  adminSession.accessToken = 'admin-access-token';
  adminSession.refreshToken = 'admin-refresh-token';
  await adminSession.save();
}

beforeEach(() => {
  jar.clear();
  vi.clearAllMocks();
  mockAuditRecord.mockResolvedValue({ id: 'audit-1' });
  mockGetMemberRole.mockResolvedValue(undefined); // never a member — hasCapability resolves false
  mockFindForSessionSync.mockImplementation(async (id: string) => {
    if (id === ADMIN_ID) return adminSyncRow();
    if (id === TARGET_ID) return targetSyncRow();
    return null;
  });
  mockFindById.mockImplementation(async (id: string) => {
    if (id === TARGET_ID) {
      return {
        id: TARGET_ID,
        email: 'target@northwind.test',
        firstName: 'Tara',
        lastName: 'Getty',
        avatarUrl: null,
      };
    }
    return undefined;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BAL-553 AC 3 — the impersonation guard end-to-end', () => {
  it('start → real guard refuses → mutation control → stop → guard no longer refuses', async () => {
    // ── Step 1 — seed a real admin session. Real seal, into the jar. ──────
    await seedAdminSession();

    // ── Step 2 — the real start path. ──────────────────────────────────────
    const startResult = await startImpersonationAction({
      targetUserId: TARGET_ID,
      reason: 'support ticket 42',
    });
    expect(startResult).toMatchObject({ success: true, targetUserId: TARGET_ID });

    // ── Step 3 — prove the SEAL, not a mock. ───────────────────────────────
    const sealedAfterStart = jar.get(COOKIE_NAME)?.value;
    expect(sealedAfterStart).toEqual(expect.any(String));
    if (sealedAfterStart === undefined) throw new Error('expected balo_session to be set');
    const unsealedAfterStart = await unsealData<SessionData>(sealedAfterStart, {
      password: TEST_PASSWORD,
    });
    expect(unsealedAfterStart.user?.id).toBe(TARGET_ID);
    expect(unsealedAfterStart.user?.isImpersonating).toBe(true);
    expect(unsealedAfterStart.user?.impersonatorUserId).toBe(ADMIN_ID);
    expect(unsealedAfterStart.user?.platformRole).toBe('user');
    expect(unsealedAfterStart.accessToken).toBeUndefined();
    expect(unsealedAfterStart.refreshToken).toBeUndefined();

    // ── Step 4 — fire the guard through the REAL path. Nothing here hand-sets a flag:
    //     startContinueToMandate() calls the real requireOnboardedUser(), which calls the real
    //     getSession(), which unseals the cookie step 2 wrote. ────────────────────────────────
    const guardedResult = await startContinueToMandate();
    expect(guardedResult).toEqual({ status: 'forbidden' });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(IMPERSONATION_REFUSAL_MESSAGE, {
      action: 'startContinueToMandate',
      companyId: TARGET_COMPANY_ID,
      actorUserId: TARGET_ID,
      impersonatorUserId: ADMIN_ID,
    });

    // ── Step 5 — prove it short-circuited: no downstream work is paid to say no. ─────────────
    expect(mockFindByCompanyId).not.toHaveBeenCalled();

    // ── Step 6 — non-vacuity / mutation control, REQUIRED. Overwrite the live cookie with a
    //     NORMAL session for the SAME target (never through startImpersonationAction), and prove
    //     the guard does NOT fire — without this the test would pass against a guard refusing
    //     unconditionally. The impersonated cookie is captured first and restored afterward so
    //     the stop control below still operates on the real impersonated session. ─────────────
    const impersonatedCookie = jar.get(COOKIE_NAME);
    if (impersonatedCookie === undefined) {
      throw new Error('expected the impersonated cookie to be set after step 2');
    }
    vi.clearAllMocks();
    mockGetMemberRole.mockResolvedValue(undefined);

    const normalTargetSession = await getSession();
    normalTargetSession.user = {
      id: TARGET_ID,
      email: 'target@northwind.test',
      firstName: 'Tara',
      lastName: 'Getty',
      avatarUrl: null,
      activeMode: 'client',
      onboardingCompleted: true,
      platformRole: 'user',
      companyId: TARGET_COMPANY_ID,
      companyName: 'Northwind Industrial',
      companyRole: 'owner',
    };
    normalTargetSession.accessToken = 'target-access-token';
    normalTargetSession.refreshToken = 'target-refresh-token';
    await normalTargetSession.save();

    const controlResult = await startContinueToMandate();
    // The impersonation guard did not fire — whatever status comes back is for an unrelated
    // reason (no MANAGE_BILLING membership in this harness); only the ABSENCE of the refusal
    // log line is asserted.
    expect(controlResult).toEqual({ status: 'forbidden' });
    expect(log.warn).not.toHaveBeenCalledWith(IMPERSONATION_REFUSAL_MESSAGE, expect.anything());
    // BAL-553 fix round 1, F9 — POSITIVE liveness, not just the absence of the refusal line.
    // Without this, a `requireOnboardedUser()` failure (e.g. a broken cookie restore above)
    // would ALSO produce no refusal log line and this control would pass for the wrong reason.
    // `hasCapability` reaching `getMemberRole` proves the real path ran past the guard.
    expect(mockGetMemberRole).toHaveBeenCalled();

    // Restore the impersonated cookie exactly as it was.
    jar.set(COOKIE_NAME, impersonatedCookie);

    // ── Step 7 — stop control. ──────────────────────────────────────────────────────────────
    vi.clearAllMocks();
    mockGetMemberRole.mockResolvedValue(undefined);
    const stopResult = await stopImpersonationAction();
    expect(stopResult).toEqual({ success: true });

    const sealedAfterStop = jar.get(COOKIE_NAME)?.value;
    if (sealedAfterStop === undefined) throw new Error('expected balo_session to be set');
    const unsealedAfterStop = await unsealData<SessionData>(sealedAfterStop, {
      password: TEST_PASSWORD,
    });
    expect(unsealedAfterStop.user?.id).toBe(ADMIN_ID);
    expect(unsealedAfterStop.user?.isImpersonating).toBeUndefined();
    expect(unsealedAfterStop.accessToken).toBe('admin-access-token');
    expect(unsealedAfterStop.refreshToken).toBe('admin-refresh-token');
    expect(jar.get(PRESERVED_ADMIN_COOKIE)).toBeUndefined();

    const postStopResult = await startContinueToMandate();
    expect(postStopResult).toEqual({ status: 'forbidden' });
    expect(log.warn).not.toHaveBeenCalledWith(IMPERSONATION_REFUSAL_MESSAGE, expect.anything());
  });

  it('TTL — the started session gets a 1800s cookie; the stopped/restored session gets the 7-day cookie', async () => {
    await seedAdminSession();

    await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'ttl check' });
    expect(jarOptionsOf(COOKIE_NAME)?.maxAge).toBe(1800);

    await stopImpersonationAction();
    expect(jarOptionsOf(COOKIE_NAME)?.maxAge).toBe(60 * 60 * 24 * 7);
  });

  // BAL-553 fix round 1, F4 part 2 — AC 4's OTHER half. `session.test.ts` pins the
  // `getSession()`-pre-arm chokepoint in isolation (one `updateConfig` call assertion), and
  // `session-sync/route.test.ts` pins the route's field survival — but `route.test.ts` MOCKS
  // `@/lib/auth/session` entirely, so it structurally cannot see whether the real `getSession()`
  // pre-arm actually keeps a REPAIR save at 30 minutes rather than the 7-day default. This is the
  // one place both are real at once: the real `getSession()`, the real session-sync route, and a
  // real cookie jar.
  it('AC 4 — a repair save through the REAL session-sync route stays at maxAge 1800, not 604800', async () => {
    await seedAdminSession();
    await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'AC4 repair check' });
    expect(jarOptionsOf(COOKIE_NAME)?.maxAge).toBe(1800);

    // The impersonated TARGET's DB row says 'expert', but derives no expert workspace (no
    // approved profile) — the exact condition that fires the route's repair write.
    mockFindForSessionSync.mockResolvedValueOnce({
      status: 'active',
      activeMode: 'expert',
      platformRole: 'user',
      onboardingCompleted: true,
      deletedAt: null,
      expertProfileId: null,
    });
    mockLoadWorkspaceDerivationMaterials.mockResolvedValue({
      input: {
        hasApprovedExpertProfile: false,
        memberships: [
          {
            companyId: TARGET_COMPANY_ID,
            name: 'Northwind Industrial',
            isPersonal: true,
            role: 'owner',
          },
        ],
        eligibleCompanyIds: [TARGET_COMPANY_ID],
        representedCompanies: [],
      },
      stored: { activeMode: 'expert', activeCompanyId: null },
    });

    const request = new NextRequest(new URL('/api/auth/session-sync', 'http://localhost:3000'));
    await sessionSyncGet(request);

    // The repair write DID fire — proof this test exercised the branch it claims to.
    expect(mockUsersUpdate).toHaveBeenCalledWith(TARGET_ID, { activeMode: 'client' });
    // …and the save it triggered did NOT re-arm the impersonated cookie to the 7-day default.
    expect(jarOptionsOf(COOKIE_NAME)?.maxAge).toBe(1800);

    const sealedAfterRepair = jar.get(COOKIE_NAME)?.value;
    if (sealedAfterRepair === undefined) throw new Error('expected balo_session to be set');
    const unsealedAfterRepair = await unsealData<SessionData>(sealedAfterRepair, {
      password: TEST_PASSWORD,
    });
    expect(unsealedAfterRepair.user?.isImpersonating).toBe(true);
    expect(unsealedAfterRepair.user?.impersonatorUserId).toBe(ADMIN_ID);
  });

  it('seal expiry — advancing past 30 minutes makes getSession() yield no user; the SEAL itself has expired', async () => {
    await seedAdminSession();
    await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'expiry check' });

    const startedAt = Date.now();
    vi.useFakeTimers();
    // iron-session adds a FIXED 60s clock-skew allowance on top of ttl before a seal is
    // expired (memory: `switch-token.test.ts` pins the same behaviour) — advance well past
    // both. This is the assertion that would fail if someone set `maxAge` without `ttl`.
    vi.setSystemTime(startedAt + (1800 + 60 + 30) * 1000);

    const sessionAfterExpiry = await getSession();
    expect(sessionAfterExpiry.user).toBeUndefined();
  });
});
