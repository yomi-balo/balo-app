import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockUpdateProfile = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { saveRateAction } from './save-rate';
import { revalidatePath } from 'next/cache';

// ── Helpers ──────────────────────────────────────────────────────

const EXPERT_SESSION = {
  user: {
    id: 'user-1',
    email: 'expert@example.com',
    activeMode: 'expert',
    expertProfileId: 'profile-1',
  },
  save: mockSave,
};

// ── Tests ────────────────────────────────────────────────────────

describe('saveRateAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
    mockUpdateProfile.mockResolvedValue(undefined);
  });

  describe('authentication', () => {
    it('throws when no session user', async () => {
      mockSessionObj = { save: mockSave };
      await expect(saveRateAction({ ratePerMinuteCents: 200 })).rejects.toThrow('Unauthorized');
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });
  });

  describe('expert mode guard', () => {
    it('returns error when not in expert mode', async () => {
      mockSessionObj = {
        user: { id: 'user-1', activeMode: 'client', expertProfileId: 'profile-1' },
        save: mockSave,
      };
      const result = await saveRateAction({ ratePerMinuteCents: 200 });
      expect(result).toEqual({ success: false, error: 'Expert profile required' });
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });

    it('returns error when no expertProfileId', async () => {
      mockSessionObj = {
        user: { id: 'user-1', activeMode: 'expert', expertProfileId: null },
        save: mockSave,
      };
      const result = await saveRateAction({ ratePerMinuteCents: 200 });
      expect(result).toEqual({ success: false, error: 'Expert profile required' });
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });
  });

  describe('input validation', () => {
    it('rejects negative rate', async () => {
      const result = await saveRateAction({ ratePerMinuteCents: -1 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('negative');
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });

    it('rejects rate exceeding max (5000 cents)', async () => {
      const result = await saveRateAction({ ratePerMinuteCents: 5001 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('exceed');
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });

    it('rejects non-integer rate', async () => {
      const result = await saveRateAction({ ratePerMinuteCents: 1.5 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('whole number');
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });

    it('accepts zero rate', async () => {
      const result = await saveRateAction({ ratePerMinuteCents: 0 });
      expect(result.success).toBe(true);
      expect(mockUpdateProfile).toHaveBeenCalledWith('profile-1', { hourlyRate: 0 });
    });

    it('accepts max rate (5000 cents)', async () => {
      const result = await saveRateAction({ ratePerMinuteCents: 5000 });
      expect(result.success).toBe(true);
      expect(mockUpdateProfile).toHaveBeenCalledWith('profile-1', { hourlyRate: 5000 });
    });
  });

  describe('successful save', () => {
    it('persists rate to database', async () => {
      const result = await saveRateAction({ ratePerMinuteCents: 200 });
      expect(result).toEqual({ success: true });
      expect(mockUpdateProfile).toHaveBeenCalledWith('profile-1', { hourlyRate: 200 });
    });

    it('revalidates settings path', async () => {
      await saveRateAction({ ratePerMinuteCents: 200 });
      expect(revalidatePath).toHaveBeenCalledWith('/expert/settings');
    });
  });

  describe('error handling', () => {
    it('returns generic error when repository throws', async () => {
      mockUpdateProfile.mockRejectedValue(new Error('DB connection failed'));
      const result = await saveRateAction({ ratePerMinuteCents: 200 });
      expect(result).toEqual({
        success: false,
        error: 'Failed to save rate. Please try again.',
      });
    });
  });
});
