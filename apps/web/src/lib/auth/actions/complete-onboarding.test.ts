import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

const mockUpdate = vi.fn();
// BAL-568 — the account-liveness gate reads the LIVE row through `readLiveUserRow`.
const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    update: (...args: unknown[]) => mockUpdate(...args),
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
  },
}));

// `readLiveUserRow` is `React.cache()`'d; a unit test has no request scope, so pass it through.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: vi.fn(),
  AUTH_SERVER_EVENTS: { SESSION_INVALIDATED: 'auth_session_invalidated' },
}));

const LIVE_ROW = { status: 'active', deletedAt: null };
const SUSPENDED_ROW = { status: 'suspended', deletedAt: null };

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { completeOnboardingAction } from './complete-onboarding';

// ── Tests ───────────────────────────────────────────────────────

describe('completeOnboardingAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({});
    mockSave.mockResolvedValue(undefined);
    mockFindForSessionSync.mockResolvedValue(LIVE_ROW);
    mockSessionObj = {
      user: { id: 'user-1', activeMode: 'client', onboardingCompleted: false },
      save: mockSave,
    };
  });

  /**
   * BAL-568 — one of the bounded `getSession()`-only set. There is no chokepoint to fold into, so
   * the gate is explicit here, and what matters is that it runs BEFORE the first repository write.
   */
  describe('BAL-568 — account liveness', () => {
    it('⚠ refuses a SUSPENDED actor before any repository write', async () => {
      mockFindForSessionSync.mockResolvedValue(SUSPENDED_ROW);

      const result = await completeOnboardingAction('client');

      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('refuses a SOFT-DELETED actor before any repository write', async () => {
      mockFindForSessionSync.mockResolvedValue({
        status: 'active',
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const result = await completeOnboardingAction('client');

      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('fails CLOSED when the live-row read throws', async () => {
      mockFindForSessionSync.mockRejectedValue(new Error('connection terminated'));

      const result = await completeOnboardingAction('client');

      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('⚠ an unauthenticated caller pays ZERO live-row reads', async () => {
      mockSessionObj = {};

      await completeOnboardingAction('client');

      expect(mockFindForSessionSync).not.toHaveBeenCalled();
    });
  });

  describe('input validation', () => {
    it('returns error for invalid intent value', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await completeOnboardingAction('admin' as any);
      expect(result).toEqual({
        success: false,
        error: 'Invalid selection',
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('returns error for empty string', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await completeOnboardingAction('' as any);
      expect(result).toEqual({
        success: false,
        error: 'Invalid selection',
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('authentication', () => {
    it('returns error when session has no user', async () => {
      mockSessionObj = { save: mockSave };
      const result = await completeOnboardingAction('client');
      expect(result).toEqual({
        success: false,
        error: 'Unauthorized',
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('returns error when onboarding is already completed', async () => {
      mockSessionObj = {
        user: { id: 'user-1', activeMode: 'client', onboardingCompleted: true },
        save: mockSave,
      };
      const result = await completeOnboardingAction('client');
      expect(result).toEqual({
        success: false,
        error: 'Onboarding already completed',
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('database update', () => {
    it('calls usersRepository.update with activeMode client and onboardingCompleted true', async () => {
      await completeOnboardingAction('client');
      expect(mockUpdate).toHaveBeenCalledWith('user-1', {
        activeMode: 'client',
        onboardingCompleted: true,
      });
    });

    it('sets activeMode to client even when intent is expert', async () => {
      await completeOnboardingAction('expert');
      expect(mockUpdate).toHaveBeenCalledWith('user-1', {
        activeMode: 'client',
        onboardingCompleted: true,
      });
    });
  });

  describe('session update', () => {
    it('updates session.user.onboardingCompleted to true', async () => {
      await completeOnboardingAction('client');
      const user = mockSessionObj.user as Record<string, unknown>;
      expect(user.onboardingCompleted).toBe(true);
    });

    it('updates session.user.activeMode to client', async () => {
      await completeOnboardingAction('client');
      const user = mockSessionObj.user as Record<string, unknown>;
      expect(user.activeMode).toBe('client');
    });

    it('calls session.save()', async () => {
      await completeOnboardingAction('client');
      expect(mockSave).toHaveBeenCalledOnce();
    });
  });

  describe('redirect routing', () => {
    it('returns redirectTo /dashboard for intent client', async () => {
      const result = await completeOnboardingAction('client');
      expect(result).toEqual({
        success: true,
        data: { redirectTo: '/dashboard' },
      });
    });

    it('returns redirectTo /expert/apply for intent expert', async () => {
      const result = await completeOnboardingAction('expert');
      expect(result).toEqual({
        success: true,
        data: { redirectTo: '/expert/apply' },
      });
    });
  });

  describe('error handling', () => {
    it('returns error when usersRepository.update throws', async () => {
      mockUpdate.mockRejectedValue(new Error('DB error'));
      const result = await completeOnboardingAction('client');
      expect(result).toEqual({
        success: false,
        error: 'Something went wrong. Please try again.',
      });
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('returns error when session.save() throws', async () => {
      mockSave.mockRejectedValue(new Error('Cookie error'));
      const result = await completeOnboardingAction('client');
      expect(result).toEqual({
        success: false,
        error: 'Something went wrong. Please try again.',
      });
    });
  });
});
