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
  mockCreateWithWorkspace,
  mockUpdate,
  mockFindWithCompany,
  mockExpertFindFirst,
} = vi.hoisted(() => ({
  mockFindByWorkosId: vi.fn(),
  mockCreateWithWorkspace: vi.fn(),
  mockUpdate: vi.fn(),
  mockFindWithCompany: vi.fn(),
  mockExpertFindFirst: vi.fn(),
}));
vi.mock('@balo/db', () => ({
  usersRepository: {
    findByWorkosId: mockFindByWorkosId,
    createWithWorkspace: mockCreateWithWorkspace,
    update: mockUpdate,
    findWithCompany: mockFindWithCompany,
  },
  db: { query: { expertProfiles: { findFirst: mockExpertFindFirst } } },
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
