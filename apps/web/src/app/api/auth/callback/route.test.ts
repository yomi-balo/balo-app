import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ── Mocks ───────────────────────────────────────────────────────

const mockAuthenticateWithCode = vi.fn();
vi.mock('@/lib/auth/config', () => ({
  getWorkOS: () => ({
    userManagement: { authenticateWithCode: (...a: unknown[]) => mockAuthenticateWithCode(...a) },
  }),
  clientId: 'test-client-id',
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({ getSession: () => Promise.resolve(mockSessionObj) }));

const {
  mockFindByWorkosId,
  mockFindByEmail,
  mockRelinkWorkosId,
  mockCreateWithWorkspace,
  mockUpdate,
  mockFindWithCompany,
  mockExpertFindFirst,
  mockTrackServerAndFlush,
} = vi.hoisted(() => ({
  mockFindByWorkosId: vi.fn(),
  mockFindByEmail: vi.fn(),
  mockRelinkWorkosId: vi.fn(),
  mockCreateWithWorkspace: vi.fn(),
  mockUpdate: vi.fn(),
  mockFindWithCompany: vi.fn(),
  mockExpertFindFirst: vi.fn(),
  mockTrackServerAndFlush: vi.fn(),
}));
vi.mock('@balo/db', () => ({
  usersRepository: {
    findByWorkosId: mockFindByWorkosId,
    findByEmail: mockFindByEmail,
    relinkWorkosId: mockRelinkWorkosId,
    createWithWorkspace: mockCreateWithWorkspace,
    update: mockUpdate,
    findWithCompany: mockFindWithCompany,
  },
  db: { query: { expertProfiles: { findFirst: mockExpertFindFirst } } },
}));

// BAL-360: the route now emits server analytics on re-link / conflict. Mocking the
// seam keeps posthog-node / next/server `after()` out of the test.
const AUTH_SERVER_EVENTS = {
  OAUTH_CALLBACK_RELINK: 'oauth_callback_relink',
  OAUTH_CALLBACK_CONFLICT_409: 'oauth_callback_conflict_409',
} as const;
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrackServerAndFlush(...a),
  AUTH_SERVER_EVENTS: {
    OAUTH_CALLBACK_RELINK: 'oauth_callback_relink',
    OAUTH_CALLBACK_CONFLICT_409: 'oauth_callback_conflict_409',
  },
}));

vi.mock('@/lib/auth/validation', () => ({ isValidReturnTo: () => false }));
vi.mock('@/lib/logging', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: () => Promise.resolve(),
}));
vi.mock('@/lib/analytics/party-domains', () => ({ emitDomainCapture: vi.fn() }));

const mockRunDomainJoinAndEmit = vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock('@/lib/domain-join/run-domain-join', () => ({
  runDomainJoinAndEmit: (...a: unknown[]) => mockRunDomainJoinAndEmit(...a),
}));

const mockRedirect = vi.fn((url: URL) => ({ url: url.toString(), cookies: { delete: vi.fn() } }));
vi.mock('next/server', () => ({ NextResponse: { redirect: (url: URL) => mockRedirect(url) } }));

import { GET } from './route';

// ── Helpers ─────────────────────────────────────────────────────

function makeReq(code: string | null): NextRequest {
  return {
    nextUrl: {
      searchParams: { get: (k: string) => (k === 'code' ? code : null) },
      pathname: '/api/auth/callback',
    },
    url: 'https://app.test/api/auth/callback',
    cookies: { get: () => undefined },
  } as unknown as NextRequest;
}

function workosUser(over: Record<string, unknown> = {}) {
  return {
    id: 'workos-1',
    email: 'jane@corp.io',
    firstName: 'Jane',
    lastName: 'Doe',
    profilePictureUrl: null,
    emailVerified: true,
    ...over,
  };
}

function newUserCreateResult() {
  return {
    user: {
      id: 'user-1',
      email: 'jane@corp.io',
      firstName: 'Jane',
      lastName: 'Doe',
      avatarUrl: null,
      activeMode: 'client',
      onboardingCompleted: false,
      platformRole: 'user',
    },
    company: { id: 'co-1', name: 'Corp' },
    membership: { role: 'owner' },
    domainCapture: { outcome: 'not_applicable' },
  };
}

function setupNewUser(over: Record<string, unknown> = {}) {
  mockAuthenticateWithCode.mockResolvedValue({
    user: workosUser(over),
    accessToken: 'at',
    refreshToken: 'rt',
  });
  mockFindByWorkosId.mockResolvedValue(null);
  // BAL-360: default the email fallback to a miss so the create path is unaffected.
  mockFindByEmail.mockResolvedValue(null);
  mockCreateWithWorkspace.mockResolvedValue(newUserCreateResult());
  mockExpertFindFirst.mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionObj = { save: mockSave };
});

// ── Tests ───────────────────────────────────────────────────────

describe('OAuth callback — domain auto-join wiring (BAL-345)', () => {
  it('runs the match engine for a NEW user with the real WorkOS emailVerified flag (true)', async () => {
    setupNewUser({ emailVerified: true });
    await GET(makeReq('auth-code'));
    expect(mockRunDomainJoinAndEmit).toHaveBeenCalledWith({
      userId: 'user-1',
      email: 'jane@corp.io',
      emailVerified: true,
    });
  });

  it('passes emailVerified: false when WorkOS reports an unverified OAuth email', async () => {
    setupNewUser({ emailVerified: false });
    await GET(makeReq('auth-code'));
    expect(mockRunDomainJoinAndEmit).toHaveBeenCalledWith(
      expect.objectContaining({ emailVerified: false })
    );
  });

  it('does NOT run the match engine for an EXISTING user', async () => {
    mockAuthenticateWithCode.mockResolvedValue({
      user: workosUser(),
      accessToken: 'at',
      refreshToken: 'rt',
    });
    mockFindByWorkosId.mockResolvedValue({ id: 'user-1', email: 'jane@corp.io' });
    mockUpdate.mockResolvedValue({
      id: 'user-1',
      email: 'jane@corp.io',
      firstName: 'Jane',
      lastName: 'Doe',
      avatarUrl: null,
      activeMode: 'client',
      onboardingCompleted: true,
      platformRole: 'user',
      emailVerified: true,
    });
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [{ role: 'owner', company: { id: 'co-1', name: 'Corp' } }],
    });
    mockExpertFindFirst.mockResolvedValue(null);

    await GET(makeReq('auth-code'));
    expect(mockRunDomainJoinAndEmit).not.toHaveBeenCalled();
  });

  it('swallows a match-engine throw — the callback still redirects (auth unaffected)', async () => {
    setupNewUser();
    mockRunDomainJoinAndEmit.mockRejectedValueOnce(new Error('engine boom'));

    await GET(makeReq('auth-code'));

    // New user → redirect to /onboarding, NOT the /login error page.
    const redirectedTo = mockRedirect.mock.calls.at(-1)?.[0].toString() ?? '';
    expect(redirectedTo).toContain('/onboarding');
    expect(redirectedTo).not.toContain('error=auth_failed');
  });
});

describe('OAuth callback — identity re-link + conflict resolution (BAL-360)', () => {
  const returningMembership = {
    companyMemberships: [{ role: 'owner', company: { id: 'co-1', name: 'Corp' } }],
  };
  const returningUpdatedUser = {
    id: 'user-1',
    email: 'jane@corp.io',
    firstName: 'Jane',
    lastName: 'Doe',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    emailVerified: true,
  };

  it('(a) re-links a workosId miss onto a LIVE verified-email user and takes the returning path', async () => {
    mockAuthenticateWithCode.mockResolvedValue({
      user: workosUser({ emailVerified: true }),
      accessToken: 'at',
      refreshToken: 'rt',
    });
    mockFindByWorkosId.mockResolvedValue(null);
    mockFindByEmail.mockResolvedValue({ id: 'user-1', workosId: 'W1', email: 'jane@corp.io' });
    mockRelinkWorkosId.mockResolvedValue({ ...returningUpdatedUser, workosId: 'workos-1' });
    mockUpdate.mockResolvedValue(returningUpdatedUser);
    mockFindWithCompany.mockResolvedValue(returningMembership);
    mockExpertFindFirst.mockResolvedValue(null);

    await GET(makeReq('auth-code'));

    expect(mockRelinkWorkosId).toHaveBeenCalledWith('user-1', 'workos-1', {
      actorUserId: 'user-1',
      oldWorkosId: 'W1',
      email: 'jane@corp.io',
      emailVerified: true,
    });
    expect(mockCreateWithWorkspace).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(AUTH_SERVER_EVENTS.OAUTH_CALLBACK_RELINK, {
      distinct_id: 'user-1',
    });
    // Re-linked user is NOT a new user — no welcome email / domain-join.
    expect(mockRunDomainJoinAndEmit).not.toHaveBeenCalled();

    const redirectedTo = mockRedirect.mock.calls.at(-1)?.[0].toString() ?? '';
    expect(redirectedTo).not.toContain('error=account_exists');
    // onboardingCompleted: true → dashboard (returning path), not /onboarding.
    expect(redirectedTo).toContain('/dashboard');
  });

  it('(b) refuses to re-link an UNVERIFIED profile onto a live email — redirects account_exists', async () => {
    mockAuthenticateWithCode.mockResolvedValue({
      user: workosUser({ emailVerified: false }),
      accessToken: 'at',
      refreshToken: 'rt',
    });
    mockFindByWorkosId.mockResolvedValue(null);
    mockFindByEmail.mockResolvedValue({ id: 'user-9', workosId: 'W1', email: 'jane@corp.io' });

    await GET(makeReq('auth-code'));

    expect(mockRelinkWorkosId).not.toHaveBeenCalled();
    expect(mockCreateWithWorkspace).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      AUTH_SERVER_EVENTS.OAUTH_CALLBACK_CONFLICT_409,
      { distinct_id: 'user-9' }
    );

    const redirectedTo = mockRedirect.mock.calls.at(-1)?.[0].toString() ?? '';
    expect(redirectedTo).toContain('error=account_exists');
    expect(redirectedTo).not.toContain('error=auth_failed');
  });

  it('(c) creates a brand-new user when neither workosId nor email match (unchanged)', async () => {
    setupNewUser();

    await GET(makeReq('auth-code'));

    expect(mockCreateWithWorkspace).toHaveBeenCalled();
    expect(mockRelinkWorkosId).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();

    const redirectedTo = mockRedirect.mock.calls.at(-1)?.[0].toString() ?? '';
    expect(redirectedTo).toContain('/onboarding');
  });

  it('(d) resolves an existing workosId hit without consulting the email fallback (unchanged)', async () => {
    mockAuthenticateWithCode.mockResolvedValue({
      user: workosUser(),
      accessToken: 'at',
      refreshToken: 'rt',
    });
    mockFindByWorkosId.mockResolvedValue({ id: 'user-1', email: 'jane@corp.io', avatarUrl: null });
    mockUpdate.mockResolvedValue(returningUpdatedUser);
    mockFindWithCompany.mockResolvedValue(returningMembership);
    mockExpertFindFirst.mockResolvedValue(null);

    await GET(makeReq('auth-code'));

    expect(mockFindByEmail).not.toHaveBeenCalled();
    expect(mockRelinkWorkosId).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();

    const redirectedTo = mockRedirect.mock.calls.at(-1)?.[0].toString() ?? '';
    expect(redirectedTo).toContain('/dashboard');
    expect(redirectedTo).not.toContain('error=');
  });
});
