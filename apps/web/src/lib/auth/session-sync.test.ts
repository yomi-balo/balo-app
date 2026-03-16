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
