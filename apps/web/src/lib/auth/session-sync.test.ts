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

// log is auto-mocked by apps/web/src/test/setup.ts — import to assert calls
import { log } from '@/lib/logging';

import { syncSessionWithDb } from './session-sync';

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

describe('syncSessionWithDb', () => {
  // 1. No session (no user) → returns invalidated/suspended
  it('returns invalidated/suspended when there is no session user', async () => {
    mockGetSession.mockResolvedValue({ user: undefined });

    const result = await syncSessionWithDb();

    expect(result).toEqual({ action: 'invalidated', reason: 'suspended' });
  });

  // 2. User not found in DB → destroys session, returns invalidated/deleted
  it('destroys session and returns invalidated/deleted when user not found in DB', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(undefined);

    const result = await syncSessionWithDb();

    expect(session.destroy).toHaveBeenCalledOnce();
    expect(result).toEqual({ action: 'invalidated', reason: 'deleted' });
  });

  // 3. User soft-deleted (deletedAt set) → destroys session, returns invalidated/deleted
  it('destroys session and returns invalidated/deleted when user is soft-deleted', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ deletedAt: new Date('2025-01-01') }));

    const result = await syncSessionWithDb();

    expect(session.destroy).toHaveBeenCalledOnce();
    expect(result).toEqual({ action: 'invalidated', reason: 'deleted' });
  });

  // 4. User suspended (status: 'suspended') → destroys session, returns invalidated/suspended
  it('destroys session and returns invalidated/suspended when user status is suspended', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ status: 'suspended' }));

    const result = await syncSessionWithDb();

    expect(session.destroy).toHaveBeenCalledOnce();
    expect(result).toEqual({ action: 'invalidated', reason: 'suspended' });
  });

  // 5. User inactive (status: 'inactive') → destroys session, returns invalidated/suspended
  it('destroys session and returns invalidated/suspended when user status is inactive', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ status: 'inactive' }));

    const result = await syncSessionWithDb();

    expect(session.destroy).toHaveBeenCalledOnce();
    expect(result).toEqual({ action: 'invalidated', reason: 'suspended' });
  });

  // 6. No drift (session matches DB) → returns ok, save NOT called
  it('returns ok and does not call save when session matches DB', async () => {
    const session = createMockSession();
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser());

    const result = await syncSessionWithDb();

    expect(result).toEqual({ action: 'ok' });
    expect(session.save).not.toHaveBeenCalled();
  });

  // 7. activeMode drift → patches session, saves, returns updated with driftFields
  it('patches session and returns updated when activeMode drifts', async () => {
    const session = createMockSession({ activeMode: 'client' });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ activeMode: 'expert' }));

    const result = await syncSessionWithDb();

    expect(session.user.activeMode).toBe('expert');
    expect(session.save).toHaveBeenCalledOnce();
    expect(result).toEqual({ action: 'updated', driftFields: ['activeMode'] });
  });

  // 8. platformRole drift → patches, returns updated
  it('patches session and returns updated when platformRole drifts', async () => {
    const session = createMockSession({ platformRole: 'user' });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ platformRole: 'admin' }));

    const result = await syncSessionWithDb();

    expect(session.user.platformRole).toBe('admin');
    expect(session.save).toHaveBeenCalledOnce();
    expect(result).toEqual({ action: 'updated', driftFields: ['platformRole'] });
  });

  // 9. onboardingCompleted drift → patches, returns updated
  it('patches session and returns updated when onboardingCompleted drifts', async () => {
    const session = createMockSession({ onboardingCompleted: false });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ onboardingCompleted: true }));

    const result = await syncSessionWithDb();

    expect(session.user.onboardingCompleted).toBe(true);
    expect(session.save).toHaveBeenCalledOnce();
    expect(result).toEqual({ action: 'updated', driftFields: ['onboardingCompleted'] });
  });

  // 10. expertProfileId drift (null in DB, string in session) → patches, returns updated
  it('patches session and returns updated when expertProfileId drifts', async () => {
    const session = createMockSession({ expertProfileId: 'ep-123' });
    mockGetSession.mockResolvedValue(session);
    mockFindForSessionSync.mockResolvedValue(createDbUser({ expertProfileId: null }));

    const result = await syncSessionWithDb();

    expect(session.user.expertProfileId).toBeUndefined();
    expect(session.save).toHaveBeenCalledOnce();
    expect(result).toEqual({ action: 'updated', driftFields: ['expertProfileId'] });
  });

  // 11. Multiple fields drift → patches all, returns all field names
  it('patches all drifted fields and returns all field names', async () => {
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

    const result = await syncSessionWithDb();

    expect(session.user.activeMode).toBe('expert');
    expect(session.user.platformRole).toBe('admin');
    expect(session.user.onboardingCompleted).toBe(true);
    expect(session.user.expertProfileId).toBe('ep-456');
    expect(session.save).toHaveBeenCalledOnce();
    expect(result).toEqual({
      action: 'updated',
      driftFields: ['activeMode', 'platformRole', 'onboardingCompleted', 'expertProfileId'],
    });
  });

  // 12. Logging assertions
  describe('logging', () => {
    it('logs a warning when user is not found in DB', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(undefined);

      await syncSessionWithDb();

      expect(log.warn).toHaveBeenCalledWith(
        'Session sync: user not found in DB, destroying session',
        { userId: 'user-1' }
      );
    });

    it('logs info when session is invalidated due to deletion', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ deletedAt: new Date('2025-01-01') }));

      await syncSessionWithDb();

      expect(log.info).toHaveBeenCalledWith('Session invalidated: user deleted', {
        userId: 'user-1',
        reason: 'deleted',
      });
    });

    it('logs info when session is invalidated due to suspension', async () => {
      const session = createMockSession();
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ status: 'suspended' }));

      await syncSessionWithDb();

      expect(log.info).toHaveBeenCalledWith('Session invalidated: user suspended', {
        userId: 'user-1',
        reason: 'suspended',
        status: 'suspended',
      });
    });

    it('logs info with drift fields when session is synced', async () => {
      const session = createMockSession({ activeMode: 'client' });
      mockGetSession.mockResolvedValue(session);
      mockFindForSessionSync.mockResolvedValue(createDbUser({ activeMode: 'expert' }));

      await syncSessionWithDb();

      expect(log.info).toHaveBeenCalledWith('Session synced: drift detected and patched', {
        userId: 'user-1',
        driftFields: ['activeMode'],
      });
    });
  });
});
