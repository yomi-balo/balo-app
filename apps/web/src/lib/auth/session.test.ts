import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

vi.mock('./config', () => ({
  sessionConfig: {
    cookieName: 'balo_session',
    password: 'x'.repeat(32),
    cookieOptions: {},
  },
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve({})),
}));

let mockSession: Record<string, unknown>;
vi.mock('iron-session', () => ({
  getIronSession: vi.fn(() => Promise.resolve(mockSession)),
}));

// BAL-568 — `session.ts` now reaches the LIVE row through `./account-liveness` → `./live-user`.
// The repository double is the whole point of the new assertions below: it is what proves an
// anonymous visitor pays ZERO reads, and it is what drives the suspended / soft-deleted arms.
const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
  },
}));

// `readLiveUserRow` is `React.cache()`'d, which needs a request scope; pass through in tests.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});

vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: vi.fn(),
  AUTH_SERVER_EVENTS: { SESSION_INVALIDATED: 'auth_session_invalidated' },
}));

import { trackServerAndFlush } from '@/lib/analytics/server';
import { log } from '@/lib/logging';
import {
  requireUser,
  requireOnboardedUser,
  getCompanyContext,
  getCurrentUser,
  getSession,
} from './session';
import type { SessionUser } from './session';
import { AccountNotLiveError } from './account-liveness';

const LIVE_ROW = { status: 'active', deletedAt: null };

// ── Helpers ─────────────────────────────────────────────────────

const baseUser = {
  id: 'user-1',
  email: 'a@b.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  avatarUrl: null,
  activeMode: 'client',
  platformRole: 'user',
  companyId: 'company-1',
  companyName: 'Test Co',
  companyRole: 'owner',
};

function userWith(onboardingCompleted: unknown): Record<string, unknown> {
  return { ...baseUser, onboardingCompleted };
}

// BAL-568 — default every suite to a LIVE row so the pre-existing contracts below are unchanged.
// ⚠ `vi.clearAllMocks()` in the nested `beforeEach`es KEEPS implementations (it clears calls and
// results only), so this survives them regardless of hook order.
beforeEach(() => {
  mockFindForSessionSync.mockResolvedValue(LIVE_ROW);
});

// ── Tests ───────────────────────────────────────────────────────

describe('requireOnboardedUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: userWith(true) };
  });

  it('throws Unauthorized when there is no user', async () => {
    mockSession = {};
    await expect(requireOnboardedUser()).rejects.toThrow('Unauthorized');
  });

  it('returns the user when onboardingCompleted is true', async () => {
    mockSession = { user: userWith(true) };
    const user = await requireOnboardedUser();
    expect(user.id).toBe('user-1');
  });

  it('throws Onboarding not completed when onboardingCompleted is false', async () => {
    mockSession = { user: userWith(false) };
    await expect(requireOnboardedUser()).rejects.toThrow('Onboarding not completed');
  });

  it('throws Onboarding not completed when onboardingCompleted is undefined (fail-closed)', async () => {
    mockSession = { user: { ...baseUser } };
    await expect(requireOnboardedUser()).rejects.toThrow('Onboarding not completed');
  });

  it('throws Onboarding not completed when onboardingCompleted is null (fail-closed)', async () => {
    mockSession = { user: userWith(null) };
    await expect(requireOnboardedUser()).rejects.toThrow('Onboarding not completed');
  });
});

describe('requireUser (unchanged contract — regression guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an un-onboarded user WITHOUT throwing (contract not overloaded)', async () => {
    mockSession = { user: userWith(false) };
    const user = await requireUser();
    expect(user.id).toBe('user-1');
    expect(user.onboardingCompleted).toBe(false);
  });

  it('throws Unauthorized when there is no user', async () => {
    mockSession = {};
    await expect(requireUser()).rejects.toThrow('Unauthorized');
  });
});

describe('SessionUser.activeWorkspace / workspaces (BAL-494 / ADR-1053) — optional fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a legacy SessionUser literal with no activeWorkspace satisfies the type — compile-time pin', () => {
    // 7-day cookies SEALED BEFORE BAL-494 carry no `activeWorkspace`. If it became a required
    // field on SessionUser, this literal would fail `pnpm typecheck` ("Property
    // 'activeWorkspace' is missing"), not just fail at runtime — that is the point of pinning
    // it here as an assignment, not a cast.
    const legacyUser: SessionUser = {
      id: 'user-1',
      email: 'a@b.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      avatarUrl: null,
      activeMode: 'client',
      onboardingCompleted: true,
      platformRole: 'user',
      companyId: 'company-1',
      companyName: 'Test Co',
      companyRole: 'owner',
    };
    expect(legacyUser.activeWorkspace).toBeUndefined();
  });

  it('requireUser() returns a session user missing activeWorkspace without throwing or coercion', async () => {
    // `baseUser` (used throughout this file) carries no `activeWorkspace`, modelling a session
    // sealed before BAL-494 shipped. Deserialization (the mocked iron-session round trip)
    // must not choke on its absence.
    mockSession = { user: userWith(true) };
    const user = await requireUser();
    expect(user.id).toBe('user-1');
    expect(user.activeWorkspace).toBeUndefined();
  });

  it('requireUser() round-trips a session user that DOES carry activeWorkspace', async () => {
    const workspace = {
      type: 'company' as const,
      key: 'company:company-1',
      companyId: 'company-1',
      name: 'Test Co',
      via: 'membership' as const,
      isPersonal: false,
    };
    mockSession = { user: { ...userWith(true), activeWorkspace: workspace } };
    const user = await requireUser();
    expect(user.activeWorkspace).toEqual(workspace);
  });
});

describe('getSession() — BAL-553 impersonated-session TTL pre-arm chokepoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls session.updateConfig with the REMAINING time (not a fresh 30 minutes) for an impersonated session', async () => {
    const updateConfig = vi.fn();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes left
    mockSession = {
      user: { ...userWith(true), isImpersonating: true, impersonationExpiresAt: expiresAt },
      updateConfig,
    };

    await getSession();

    expect(updateConfig).toHaveBeenCalledTimes(1);
    const [config] = updateConfig.mock.calls[0] as [{ ttl: number }];
    expect(config.ttl).toBe(15 * 60);
  });

  it('does NOT call session.updateConfig for a normal (non-impersonated) session', async () => {
    const updateConfig = vi.fn();
    mockSession = { user: userWith(true), updateConfig };

    await getSession();

    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('does NOT call session.updateConfig when isImpersonating is explicitly false', async () => {
    const updateConfig = vi.fn();
    mockSession = { user: { ...userWith(true), isImpersonating: false }, updateConfig };

    await getSession();

    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('does NOT call session.updateConfig when there is no session.user at all', async () => {
    const updateConfig = vi.fn();
    mockSession = { updateConfig };

    await getSession();

    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('returns the session object itself (not a copy)', async () => {
    mockSession = { user: userWith(true) };
    const session = await getSession();
    expect(session).toBe(mockSession);
  });
});

describe('getCompanyContext (unchanged by BAL-494)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns companyId/companyName/companyRole from the session user', async () => {
    mockSession = { user: userWith(true) };
    const ctx = await getCompanyContext();
    expect(ctx).toEqual({
      companyId: 'company-1',
      companyName: 'Test Co',
      companyRole: 'owner',
    });
  });

  it('output is unaffected by the presence of activeWorkspace on the session user', async () => {
    const workspace = {
      type: 'company' as const,
      key: 'company:company-1',
      companyId: 'company-1',
      name: 'Test Co',
      via: 'membership' as const,
      isPersonal: false,
    };
    mockSession = { user: { ...userWith(true), activeWorkspace: workspace } };
    const ctx = await getCompanyContext();
    expect(ctx).toEqual({
      companyId: 'company-1',
      companyName: 'Test Co',
      companyRole: 'owner',
    });
  });

  it('throws Unauthorized when there is no user (delegates to requireUser)', async () => {
    mockSession = {};
    await expect(getCompanyContext()).rejects.toThrow('Unauthorized');
  });
});

// ── BAL-568 — account liveness folded into the actor-resolution seams ────────────────────

describe('BAL-568 — the seams re-read the LIVE row, and the cookie stops granting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindForSessionSync.mockResolvedValue(LIVE_ROW);
  });

  /**
   * ⚠⚠ THE BINDING PERFORMANCE CONSTRAINT (ruling A2). `getCurrentUser()` runs on the root and
   * marketing layouts, i.e. on EVERY render including a logged-out marketing page. An anonymous
   * visitor must pay NOTHING: the live read happens only once a session user has been resolved.
   * Asserted here rather than left to inspection.
   */
  it('⚠ an ANONYMOUS visitor pays ZERO database reads', async () => {
    mockSession = {};

    await expect(getCurrentUser()).resolves.toBeNull();

    expect(mockFindForSessionSync).not.toHaveBeenCalled();
  });

  it('getCurrentUser returns the user for a live row, reading it exactly once', async () => {
    mockSession = { user: userWith(true) };

    const user = await getCurrentUser();

    expect(user?.id).toBe('user-1');
    expect(mockFindForSessionSync).toHaveBeenCalledTimes(1);
    expect(mockFindForSessionSync).toHaveBeenCalledWith('user-1');
  });

  /**
   * ⚠ THE COOKIE IS IGNORED, NOT DESTROYED. `getSession()` still carries a fully-populated user —
   * that is the whole point: a seven-day cookie outlives a suspension by up to a week.
   * `getCurrentUser()` must answer `null` anyway, which is the shape every shipped call site
   * already handles.
   */
  it('⚠ getCurrentUser returns NULL for a suspended row while the cookie still carries a user', async () => {
    mockSession = { user: userWith(true) };
    mockFindForSessionSync.mockResolvedValue({ status: 'suspended', deletedAt: null });

    const session = await getSession();
    expect(session.user, 'the cookie itself is untouched — it simply grants nothing').toBeDefined();

    await expect(getCurrentUser()).resolves.toBeNull();
  });

  /**
   * ⚠⚠ THE `path` DIMENSION (fix round 1, F3). `getCurrentUser` runs from `app/layout.tsx`,
   * `(marketing)/layout.tsx` and `(dashboard)/layout.tsx` — i.e. on every authenticated RENDER —
   * so it must report `'page'`. The first cut reported the hard-coded `'action'` (a plan defect,
   * §5.2), which left R3's `page` arm coming only from the sync route and hid exactly the thing
   * the dimension exists to measure: how often a suspended account is stopped OUTSIDE a page load.
   */
  it('⚠ getCurrentUser LOGS the page refusal but emits NO event', async () => {
    mockSession = { user: userWith(true) };
    mockFindForSessionSync.mockResolvedValue({ status: 'suspended', deletedAt: null });

    await getCurrentUser();

    expect(log.info).toHaveBeenCalledWith('Session invalidated: account not live', {
      userId: 'user-1',
      path: 'page',
      reason: 'suspended',
    });
    // ⚠⚠ LOG-ONLY (fix round 2, G3). The session-sync route is the ONE emitter for the page path —
    // it is where a refused render actually ejects. Emitting here as well double-counted every
    // ejection.
    expect(trackServerAndFlush).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE POLLING CASE, AND WHY G3 IS MORE THAN A COUNTING FIX. `/api/notifications` resolves its
   * actor through `getCurrentUser`, and `NotificationBell` polls it every 30s and KEEPS POLLING
   * after a 401 — so an emission on this seam is a *flushing* PostHog call every 30 seconds for
   * the entire life of a suspended user's cookie.
   */
  it('⚠ repeated getCurrentUser calls emit nothing at all — the NotificationBell poll', async () => {
    mockSession = { user: userWith(true) };
    mockFindForSessionSync.mockResolvedValue({ status: 'suspended', deletedAt: null });

    await getCurrentUser();
    await getCurrentUser();
    await getCurrentUser();

    expect(trackServerAndFlush).not.toHaveBeenCalled();
  });

  it('getCurrentUser returns NULL for a soft-deleted row', async () => {
    mockSession = { user: userWith(true) };
    mockFindForSessionSync.mockResolvedValue({
      status: 'active',
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it('getCurrentUser returns NULL when the database is unreachable (fail closed)', async () => {
    mockSession = { user: userWith(true) };
    mockFindForSessionSync.mockRejectedValue(new Error('connection terminated'));

    await expect(getCurrentUser()).resolves.toBeNull();
  });

  /**
   * ⚠ THE TWO FAILURES MUST STAY DISTINGUISHABLE, which is why `requireUser` reads `getSession()`
   * directly rather than going through `getCurrentUser()`. No session is still the generic
   * 'Unauthorized' every caller already maps; a non-live account carries the refusal CODE.
   */
  it('⚠ requireUser throws AccountNotLiveError (not the generic Unauthorized) for a suspended row', async () => {
    mockSession = { user: userWith(true) };
    mockFindForSessionSync.mockResolvedValue({ status: 'suspended', deletedAt: null });

    await expect(requireUser()).rejects.toBeInstanceOf(AccountNotLiveError);
    mockFindForSessionSync.mockResolvedValue({ status: 'suspended', deletedAt: null });
    await expect(requireUser()).rejects.toMatchObject({ code: 'account_suspended' });
  });

  it('⚠ requireUser still throws the GENERIC Unauthorized when there is no session at all', async () => {
    mockSession = {};

    await expect(requireUser()).rejects.toThrow('Unauthorized');
    await expect(requireUser()).rejects.not.toBeInstanceOf(AccountNotLiveError);
    expect(mockFindForSessionSync).not.toHaveBeenCalled();
  });

  it('requireOnboardedUser inherits the gate transitively, with no edit of its own', async () => {
    mockSession = { user: userWith(true) };
    mockFindForSessionSync.mockResolvedValue({ status: 'suspended', deletedAt: null });

    await expect(requireOnboardedUser()).rejects.toBeInstanceOf(AccountNotLiveError);
  });

  it('getCompanyContext inherits the gate transitively too', async () => {
    mockSession = { user: userWith(true) };
    mockFindForSessionSync.mockResolvedValue({ status: 'suspended', deletedAt: null });

    await expect(getCompanyContext()).rejects.toBeInstanceOf(AccountNotLiveError);
  });
});
