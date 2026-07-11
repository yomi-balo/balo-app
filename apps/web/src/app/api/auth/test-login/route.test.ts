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
