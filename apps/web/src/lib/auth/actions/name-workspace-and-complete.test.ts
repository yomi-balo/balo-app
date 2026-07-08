import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

// ── Mocks ───────────────────────────────────────────────────────

const { mockUpdateName, mockUsersUpdate } = vi.hoisted(() => ({
  mockUpdateName: vi.fn(),
  mockUsersUpdate: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  companiesRepository: { updateName: mockUpdateName },
  usersRepository: { update: mockUsersUpdate },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { nameWorkspaceAndCompleteAction } from './name-workspace-and-complete';

// ── Tests ───────────────────────────────────────────────────────

describe('nameWorkspaceAndCompleteAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateName.mockResolvedValue({ id: 'company-1', name: 'Acme Corp' });
    mockUsersUpdate.mockResolvedValue({});
    mockSave.mockResolvedValue(undefined);
    mockSessionObj = {
      user: {
        id: 'user-1',
        companyId: 'company-1',
        companyName: 'Personal Workspace',
        companyRole: 'owner',
        activeMode: 'client',
        onboardingCompleted: false,
      },
      save: mockSave,
    };
  });

  describe('input validation', () => {
    it('rejects an empty / whitespace-only name without touching the DB', async () => {
      const result = await nameWorkspaceAndCompleteAction('   ');
      expect(result).toEqual({ success: false, error: 'Enter a name for your workspace' });
      expect(mockUpdateName).not.toHaveBeenCalled();
      expect(mockUsersUpdate).not.toHaveBeenCalled();
    });

    it('rejects a name longer than 120 characters', async () => {
      const result = await nameWorkspaceAndCompleteAction('a'.repeat(121));
      expect(result).toEqual({ success: false, error: 'That name is too long' });
      expect(mockUpdateName).not.toHaveBeenCalled();
    });
  });

  describe('authentication guards', () => {
    it('returns Unauthorized when there is no session user', async () => {
      mockSessionObj = { save: mockSave };
      const result = await nameWorkspaceAndCompleteAction('Acme Corp');
      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockUpdateName).not.toHaveBeenCalled();
    });

    it('rejects when onboarding is already completed', async () => {
      (mockSessionObj.user as Record<string, unknown>).onboardingCompleted = true;
      const result = await nameWorkspaceAndCompleteAction('Acme Corp');
      expect(result).toEqual({ success: false, error: 'Onboarding already completed' });
      expect(mockUpdateName).not.toHaveBeenCalled();
    });

    it('rejects a non-owner member without touching the DB (least-privilege)', async () => {
      (mockSessionObj.user as Record<string, unknown>).companyRole = 'member';
      const result = await nameWorkspaceAndCompleteAction('Acme Corp');
      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockUpdateName).not.toHaveBeenCalled();
      expect(mockUsersUpdate).not.toHaveBeenCalled();
    });
  });

  describe('success path', () => {
    it('renames the company with the trimmed name', async () => {
      await nameWorkspaceAndCompleteAction('  Acme Corp  ');
      expect(mockUpdateName).toHaveBeenCalledWith('company-1', 'Acme Corp');
    });

    it('completes onboarding in client mode', async () => {
      await nameWorkspaceAndCompleteAction('Acme Corp');
      expect(mockUsersUpdate).toHaveBeenCalledWith('user-1', {
        activeMode: 'client',
        onboardingCompleted: true,
      });
    });

    it('refreshes the session and saves it, then returns the dashboard redirect', async () => {
      const result = await nameWorkspaceAndCompleteAction('Acme Corp');
      const user = mockSessionObj.user as Record<string, unknown>;
      expect(user.onboardingCompleted).toBe(true);
      expect(user.activeMode).toBe('client');
      expect(user.companyName).toBe('Acme Corp'); // sourced from the returned row
      expect(mockSave).toHaveBeenCalledOnce();
      expect(result).toEqual({ success: true, data: { redirectTo: '/dashboard' } });
    });
  });

  describe('error handling', () => {
    it('returns a retryable error and logs when the rename throws', async () => {
      mockUpdateName.mockRejectedValue(new Error('DB error'));
      const result = await nameWorkspaceAndCompleteAction('Acme Corp');
      expect(result).toEqual({
        success: false,
        error: "We couldn't save that just now. Please try again.",
      });
      expect(mockSave).not.toHaveBeenCalled();
      expect(vi.mocked(log.error)).toHaveBeenCalled();
    });
  });
});
