import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

// BAL-568 — the seams re-read the LIVE `users` row; this suite is not about that gate.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockUpdateProfile = vi.fn();
const mockFindProfileById = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
    findProfileById: (...args: unknown[]) => mockFindProfileById(...args),
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { saveRateAction } from './save-rate';
import { revalidatePath } from 'next/cache';
import {
  APPROVED_PROFILE_ROW,
  itEnforcesApprovedExpertGate,
} from '@/test/fixtures/approved-expert-gate-cases';

// ── Helpers ──────────────────────────────────────────────────────

const EXPERT_SESSION = {
  user: {
    onboardingCompleted: true,
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
    mockFindProfileById.mockResolvedValue(APPROVED_PROFILE_ROW);
  });

  describe('authentication', () => {
    it('throws when no session user', async () => {
      mockSessionObj = { save: mockSave };
      await expect(saveRateAction({ ratePerMinuteCents: 200 })).rejects.toThrow('Unauthorized');
      expect(mockUpdateProfile).not.toHaveBeenCalled();
    });
  });

  describe('approved expert guard', () => {
    itEnforcesApprovedExpertGate({
      setSessionUser: (u) => {
        mockSessionObj = {
          ...EXPERT_SESSION,
          user: { ...EXPERT_SESSION.user, ...u, expertProfileId: u.expertProfileId ?? null },
        };
      },
      setProfileRow: (row) => mockFindProfileById.mockResolvedValue(row),
      findProfileById: mockFindProfileById,
      run: () => saveRateAction({ ratePerMinuteCents: 200 }),
      expectAllowed: (result) => {
        expect(result).toEqual({ success: true });
        expect(mockUpdateProfile).toHaveBeenCalledWith('profile-1', { rateCents: 200 });
      },
      expectRefused: (result) =>
        expect(result).toEqual({ success: false, error: 'Expert profile required' }),
      expectNoSideEffect: () => expect(mockUpdateProfile).not.toHaveBeenCalled(),
    });

    it('returns the generic failure, without throwing, when the guard read fails', async () => {
      mockFindProfileById.mockRejectedValue(new Error('DB down'));
      const result = await saveRateAction({ ratePerMinuteCents: 200 });
      expect(result).toEqual({ success: false, error: 'Failed to save rate. Please try again.' });
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
      expect(mockUpdateProfile).toHaveBeenCalledWith('profile-1', { rateCents: 0 });
    });

    it('accepts max rate (5000 cents)', async () => {
      const result = await saveRateAction({ ratePerMinuteCents: 5000 });
      expect(result.success).toBe(true);
      expect(mockUpdateProfile).toHaveBeenCalledWith('profile-1', { rateCents: 5000 });
    });
  });

  describe('successful save', () => {
    it('persists rate to database', async () => {
      const result = await saveRateAction({ ratePerMinuteCents: 200 });
      expect(result).toEqual({ success: true });
      expect(mockUpdateProfile).toHaveBeenCalledWith('profile-1', { rateCents: 200 });
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
