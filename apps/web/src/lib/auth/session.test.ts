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

import { requireUser, requireOnboardedUser, getCompanyContext, getSession } from './session';
import type { SessionUser } from './session';

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
