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

import { checkSessionDrift } from './session-sync';

// ── Helpers ─────────────────────────────────────────────────────

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
      ...userOverrides,
    },
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
});

describe('checkSessionDrift', () => {
  // No session → sync-needed
  it('returns sync-needed when there is no session user', async () => {
    mockGetSession.mockResolvedValue({ user: undefined });

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // User not found in DB → sync-needed
  it('returns sync-needed when user not found in DB', async () => {
    mockGetSession.mockResolvedValue(createMockSession());
    mockFindForSessionSync.mockResolvedValue(undefined);

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // User soft-deleted → sync-needed
  it('returns sync-needed when user is soft-deleted', async () => {
    mockGetSession.mockResolvedValue(createMockSession());
    mockFindForSessionSync.mockResolvedValue(createDbUser({ deletedAt: new Date('2025-01-01') }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // User suspended → sync-needed
  it('returns sync-needed when user status is suspended', async () => {
    mockGetSession.mockResolvedValue(createMockSession());
    mockFindForSessionSync.mockResolvedValue(createDbUser({ status: 'suspended' }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // User inactive → sync-needed
  it('returns sync-needed when user status is inactive', async () => {
    mockGetSession.mockResolvedValue(createMockSession());
    mockFindForSessionSync.mockResolvedValue(createDbUser({ status: 'inactive' }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // No drift → ok
  it('returns ok when session matches DB', async () => {
    mockGetSession.mockResolvedValue(createMockSession());
    mockFindForSessionSync.mockResolvedValue(createDbUser());

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'ok' });
  });

  // activeMode drift → sync-needed
  it('returns sync-needed when activeMode drifts', async () => {
    mockGetSession.mockResolvedValue(createMockSession({ activeMode: 'client' }));
    mockFindForSessionSync.mockResolvedValue(createDbUser({ activeMode: 'expert' }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // platformRole drift → sync-needed
  it('returns sync-needed when platformRole drifts', async () => {
    mockGetSession.mockResolvedValue(createMockSession({ platformRole: 'user' }));
    mockFindForSessionSync.mockResolvedValue(createDbUser({ platformRole: 'admin' }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // onboardingCompleted drift → sync-needed
  it('returns sync-needed when onboardingCompleted drifts', async () => {
    mockGetSession.mockResolvedValue(createMockSession({ onboardingCompleted: false }));
    mockFindForSessionSync.mockResolvedValue(createDbUser({ onboardingCompleted: true }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // expertProfileId drift → sync-needed
  it('returns sync-needed when expertProfileId drifts', async () => {
    mockGetSession.mockResolvedValue(createMockSession({ expertProfileId: 'ep-123' }));
    mockFindForSessionSync.mockResolvedValue(createDbUser({ expertProfileId: null }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // expertProfileId: DB has value, session has undefined → sync-needed
  it('returns sync-needed when expertProfileId appears in DB', async () => {
    mockGetSession.mockResolvedValue(createMockSession({ expertProfileId: undefined }));
    mockFindForSessionSync.mockResolvedValue(createDbUser({ expertProfileId: 'ep-456' }));

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // Multiple fields drift → sync-needed
  it('returns sync-needed when multiple fields drift', async () => {
    mockGetSession.mockResolvedValue(
      createMockSession({
        activeMode: 'client',
        platformRole: 'user',
        onboardingCompleted: false,
      })
    );
    mockFindForSessionSync.mockResolvedValue(
      createDbUser({
        activeMode: 'expert',
        platformRole: 'admin',
        onboardingCompleted: true,
      })
    );

    const result = await checkSessionDrift();

    expect(result).toEqual({ action: 'sync-needed' });
  });

  // Read-only: does NOT call save or destroy
  it('never calls save or destroy (read-only check)', async () => {
    const session = {
      ...createMockSession({ activeMode: 'client' }),
      save: vi.fn(),
      destroy: vi.fn(),
    };
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ activeMode: 'expert' }));

    await checkSessionDrift();

    expect(session.save).not.toHaveBeenCalled();
    expect(session.destroy).not.toHaveBeenCalled();
  });
});
