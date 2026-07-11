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
    fakeSession: session,
  };
});

vi.mock('@balo/db', () => ({
  usersRepository: {
    findByEmail: mockFindByEmail,
    update: mockUpdate,
    findWithCompany: mockFindWithCompany,
    createWithWorkspace: mockCreateWithWorkspace,
  },
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: mockGetSession,
}));

import { POST } from './route';

// ── Helpers ─────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/test-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function enableE2E(): void {
  vi.stubEnv('E2E_TEST_AUTH', '1');
  // Non-production NODE_ENV → guard passes.
  vi.stubEnv('NODE_ENV', 'test');
}

interface UserRowOverrides {
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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/auth/test-login — production-inert guard', () => {
  it('returns 404 when E2E_TEST_AUTH is not "1"', async () => {
    vi.stubEnv('E2E_TEST_AUTH', '0');
    vi.stubEnv('NODE_ENV', 'test');
    const res = await POST(makeRequest({ onboardingCompleted: false }));
    expect(res.status).toBe(404);
    expect(mockFindByEmail).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('returns 404 in production even when E2E_TEST_AUTH="1"', async () => {
    vi.stubEnv('E2E_TEST_AUTH', '1');
    vi.stubEnv('NODE_ENV', 'production');
    const res = await POST(makeRequest({ onboardingCompleted: false }));
    expect(res.status).toBe(404);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/test-login — validation', () => {
  it('returns 400 for an invalid body', async () => {
    enableE2E();
    const res = await POST(makeRequest({ onboardingCompleted: 'nope' }));
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/test-login — session minting', () => {
  it('updates an existing plain-user row and mints a user session', async () => {
    enableE2E();
    mockFindByEmail.mockResolvedValue(userRow({ platformRole: 'user' }));
    mockUpdate.mockResolvedValue(userRow({ platformRole: 'user', onboardingCompleted: true }));
    mockFindWithCompany.mockResolvedValue({ companyMemberships: [membershipRow] });

    const res = await POST(makeRequest({ onboardingCompleted: true }));

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith('user-1', { onboardingCompleted: true });
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mintedRole()).toBe('user');
  });

  it('creates a new workspace-backed test user when none exists', async () => {
    enableE2E();
    mockFindByEmail.mockResolvedValue(undefined);
    mockCreateWithWorkspace.mockResolvedValue({
      user: userRow({ platformRole: 'user' }),
      company: { id: 'company-1', name: 'Workspace' },
      membership: { role: 'owner' },
    });

    const res = await POST(makeRequest({ onboardingCompleted: false }));

    expect(res.status).toBe(200);
    expect(mockCreateWithWorkspace).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mintedRole()).toBe('user');
  });

  it('refuses (400) and never mints a session when the derived row is elevated', async () => {
    enableE2E();
    mockFindByEmail.mockResolvedValue(userRow({ platformRole: 'admin' }));

    const res = await POST(makeRequest({ onboardingCompleted: false }));

    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(fakeSession.user).toBeUndefined();
  });

  it('returns 500 and logs when the repository throws', async () => {
    enableE2E();
    mockFindByEmail.mockRejectedValue(new Error('boom'));

    const res = await POST(makeRequest({ onboardingCompleted: false }));

    expect(res.status).toBe(500);
    expect(mockSave).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });
});
