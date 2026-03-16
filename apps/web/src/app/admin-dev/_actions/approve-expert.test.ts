import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Constants ────────────────────────────────────────────────────

const EXPERT_PROFILE_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockApproveApplication = vi.fn();
const mockUserUpdate = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    approveApplication: (...args: unknown[]) => mockApproveApplication(...args),
  },
  usersRepository: {
    update: (...args: unknown[]) => mockUserUpdate(...args),
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { approveExpertAction } from './approve-expert';
import { revalidatePath } from 'next/cache';

// ── Tests ────────────────────────────────────────────────────────

describe('approveExpertAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = {
      user: { id: 'admin-1', platformRole: 'admin' },
      save: mockSave,
    };
    mockApproveApplication.mockResolvedValue(undefined);
    mockUserUpdate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('production guard', () => {
    it('returns error when NODE_ENV is production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const result = await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(result).toEqual({ success: false, error: 'Not available in production.' });
      expect(mockApproveApplication).not.toHaveBeenCalled();
      expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it('proceeds when NODE_ENV is development', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const result = await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(result).toEqual({ success: true });
    });
  });

  describe('authentication', () => {
    it('returns Unauthorized when session has no user', async () => {
      mockSessionObj = { save: mockSave };
      const result = await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockApproveApplication).not.toHaveBeenCalled();
    });

    it('returns Unauthorized when session user has no id', async () => {
      mockSessionObj = { user: {}, save: mockSave };
      const result = await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mockApproveApplication).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns Forbidden when user has "user" platform role', async () => {
      mockSessionObj = {
        user: { id: 'user-1', platformRole: 'user' },
        save: mockSave,
      };
      const result = await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(result).toEqual({ success: false, error: 'Forbidden: admin access required.' });
      expect(mockApproveApplication).not.toHaveBeenCalled();
    });

    it('allows admin role', async () => {
      mockSessionObj = {
        user: { id: 'admin-1', platformRole: 'admin' },
        save: mockSave,
      };
      const result = await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(result).toEqual({ success: true });
    });

    it('allows super_admin role', async () => {
      mockSessionObj = {
        user: { id: 'admin-1', platformRole: 'super_admin' },
        save: mockSave,
      };
      const result = await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(result).toEqual({ success: true });
    });
  });

  describe('input validation', () => {
    it('returns error for invalid expertProfileId format', async () => {
      const result = await approveExpertAction('not-a-uuid', USER_ID);
      expect(result).toEqual({ success: false, error: 'Invalid ID format.' });
      expect(mockApproveApplication).not.toHaveBeenCalled();
    });

    it('returns error for invalid userId format', async () => {
      const result = await approveExpertAction(EXPERT_PROFILE_ID, 'not-a-uuid');
      expect(result).toEqual({ success: false, error: 'Invalid ID format.' });
      expect(mockApproveApplication).not.toHaveBeenCalled();
    });

    it('returns error when both IDs are invalid', async () => {
      const result = await approveExpertAction('bad-id', 'also-bad');
      expect(result).toEqual({ success: false, error: 'Invalid ID format.' });
      expect(mockApproveApplication).not.toHaveBeenCalled();
    });
  });

  describe('successful approval', () => {
    it('calls approveApplication with the expert profile ID', async () => {
      await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(mockApproveApplication).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
    });

    it('updates user activeMode to expert', async () => {
      await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(mockUserUpdate).toHaveBeenCalledWith(USER_ID, { activeMode: 'expert' });
    });

    it('revalidates /admin-dev path', async () => {
      await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(revalidatePath).toHaveBeenCalledWith('/admin-dev');
    });

    it('returns success result', async () => {
      const result = await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(result).toEqual({ success: true });
    });
  });

  describe('error handling', () => {
    it('returns error when approveApplication throws', async () => {
      mockApproveApplication.mockRejectedValue(new Error('DB connection failed'));
      const result = await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(result).toEqual({
        success: false,
        error: 'DB connection failed',
      });
    });

    it('returns generic error when a non-Error is thrown', async () => {
      mockApproveApplication.mockRejectedValue('unexpected failure');
      const result = await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(result).toEqual({
        success: false,
        error: 'Failed to approve expert.',
      });
    });

    it('returns error when usersRepository.update throws', async () => {
      mockUserUpdate.mockRejectedValue(new Error('Update failed'));
      const result = await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(result).toEqual({
        success: false,
        error: 'Update failed',
      });
    });

    it('does not revalidate path on failure', async () => {
      mockApproveApplication.mockRejectedValue(new Error('DB error'));
      await approveExpertAction(EXPERT_PROFILE_ID, USER_ID);
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  });
});
