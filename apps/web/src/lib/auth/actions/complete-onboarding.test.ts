import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

const mockUpdate = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

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
    mockSessionObj = {
      user: { id: 'user-1', activeMode: 'client', onboardingCompleted: false },
      save: mockSave,
    };
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
