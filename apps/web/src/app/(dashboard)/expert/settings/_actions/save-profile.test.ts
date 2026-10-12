import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

// BAL-568 — the seams re-read the LIVE `users` row; this suite is not about that gate.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockSaveSettingsProfile = vi.fn();
const mockCheckUsernameAvailability = vi.fn();
const mockFindApprovalById = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    saveSettingsProfile: (...args: unknown[]) => mockSaveSettingsProfile(...args),
    checkUsernameAvailability: (...args: unknown[]) => mockCheckUsernameAvailability(...args),
    findApprovalById: (...args: unknown[]) => mockFindApprovalById(...args),
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { saveProfileAction } from './save-profile';
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

describe('saveProfileAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
    mockSaveSettingsProfile.mockResolvedValue({ outcome: 'saved' });
    mockCheckUsernameAvailability.mockResolvedValue(true);
    mockFindApprovalById.mockResolvedValue(APPROVED_PROFILE_ROW);
  });

  describe('authentication', () => {
    it('throws when no session user', async () => {
      mockSessionObj = { save: mockSave };
      await expect(saveProfileAction({ headline: 'Test' })).rejects.toThrow('Unauthorized');
      expect(mockSaveSettingsProfile).not.toHaveBeenCalled();
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
      setProfileRow: (row) => mockFindApprovalById.mockResolvedValue(row),
      findApprovalById: mockFindApprovalById,
      run: () => saveProfileAction({ headline: 'Test' }),
      expectAllowed: (result) => {
        expect(result).toEqual({ success: true });
        expect(mockSaveSettingsProfile).toHaveBeenCalledWith('profile-1', expect.anything());
      },
      expectRefused: (result) =>
        expect(result).toEqual({ success: false, error: 'Expert profile required' }),
      expectNoSideEffect: () => expect(mockSaveSettingsProfile).not.toHaveBeenCalled(),
    });

    it('returns the generic failure, without throwing, when the guard read fails', async () => {
      mockFindApprovalById.mockRejectedValue(new Error('DB down'));
      const result = await saveProfileAction({ headline: 'Test' });
      expect(result).toEqual({
        success: false,
        error: 'Failed to save profile. Please try again.',
      });
      expect(mockSaveSettingsProfile).not.toHaveBeenCalled();
    });
  });

  describe('successful save — headline, bio, username', () => {
    it('saves headline and bio', async () => {
      const result = await saveProfileAction({
        headline: 'Senior Salesforce Consultant',
        bio: 'I have 10 years of experience.',
      });
      expect(result).toEqual({ success: true });
      expect(mockSaveSettingsProfile).toHaveBeenCalledWith('profile-1', {
        headline: 'Senior Salesforce Consultant',
        bio: 'I have 10 years of experience.',
        username: null,
        industryIds: undefined,
        languages: undefined,
      });
    });

    it('saves username when available', async () => {
      mockCheckUsernameAvailability.mockResolvedValue(true);
      const result = await saveProfileAction({ username: 'john-doe' });
      expect(result).toEqual({ success: true });
      expect(mockCheckUsernameAvailability).toHaveBeenCalledWith('john-doe', 'profile-1');
      expect(mockSaveSettingsProfile).toHaveBeenCalledWith('profile-1', {
        headline: null,
        bio: null,
        username: 'john-doe',
        industryIds: undefined,
        languages: undefined,
      });
    });

    it('revalidates settings path on success', async () => {
      await saveProfileAction({ headline: 'Test' });
      expect(revalidatePath).toHaveBeenCalledWith('/expert/settings');
    });
  });

  describe('username checks', () => {
    it('rejects taken usernames', async () => {
      mockCheckUsernameAvailability.mockResolvedValue(false);
      const result = await saveProfileAction({ username: 'taken-name' });
      expect(result).toEqual({ success: false, error: 'Username already taken' });
      expect(mockSaveSettingsProfile).not.toHaveBeenCalled();
    });

    it('rejects reserved usernames', async () => {
      const result = await saveProfileAction({ username: 'admin' });
      expect(result).toEqual({ success: false, error: 'This username is reserved' });
      expect(mockCheckUsernameAvailability).not.toHaveBeenCalled();
      expect(mockSaveSettingsProfile).not.toHaveBeenCalled();
    });

    it('does not check availability when username is empty', async () => {
      const result = await saveProfileAction({ username: '' });
      expect(result).toEqual({ success: true });
      expect(mockCheckUsernameAvailability).not.toHaveBeenCalled();
      expect(mockSaveSettingsProfile).toHaveBeenCalledWith(
        'profile-1',
        expect.objectContaining({ username: null })
      );
    });
  });

  describe('input validation', () => {
    it('rejects headline exceeding 100 characters', async () => {
      const result = await saveProfileAction({ headline: 'a'.repeat(101) });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockSaveSettingsProfile).not.toHaveBeenCalled();
    });

    it('rejects bio exceeding 1000 characters', async () => {
      const result = await saveProfileAction({ bio: 'a'.repeat(1001) });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockSaveSettingsProfile).not.toHaveBeenCalled();
    });

    it('rejects username with invalid characters', async () => {
      const result = await saveProfileAction({ username: 'UPPER_CASE!' });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockSaveSettingsProfile).not.toHaveBeenCalled();
    });

    it('rejects username shorter than minimum length', async () => {
      const result = await saveProfileAction({ username: 'ab' });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mockSaveSettingsProfile).not.toHaveBeenCalled();
    });
  });

  describe('not_found outcome (BAL-557)', () => {
    // MUTATION-PROOF: change the `not_found` branch to fall through to `{ success: true }` and
    // this goes red — proves the action actually reads the repository's outcome.
    it('maps saveSettingsProfile not_found to the expert-profile-required error', async () => {
      mockSaveSettingsProfile.mockResolvedValue({ outcome: 'not_found' });
      const result = await saveProfileAction({ headline: 'Test' });
      expect(result).toEqual({ success: false, error: 'Expert profile required' });
    });
  });

  describe('error handling', () => {
    it('returns generic error when repository throws', async () => {
      mockSaveSettingsProfile.mockRejectedValue(new Error('DB connection failed'));
      const result = await saveProfileAction({ headline: 'Test' });
      expect(result).toEqual({
        success: false,
        error: 'Failed to save profile. Please try again.',
      });
    });

    it('returns generic error when username availability check throws', async () => {
      mockCheckUsernameAvailability.mockRejectedValue(new Error('DB error'));
      const result = await saveProfileAction({ username: 'valid-name' });
      expect(result).toEqual({
        success: false,
        error: 'Failed to save profile. Please try again.',
      });
    });
  });
});
