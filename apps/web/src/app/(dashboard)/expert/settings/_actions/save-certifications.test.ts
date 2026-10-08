import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

// BAL-568 — the seams re-read the LIVE `users` row; this suite is not about that gate.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockSaveSettingsCertifications = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    saveSettingsCertifications: (...args: unknown[]) => mockSaveSettingsCertifications(...args),
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { saveCertificationsAction } from './save-certifications';
import { CERTIFICATIONS_LOCKED_ERROR } from './certifications-locked-copy';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

// ── Helpers ──────────────────────────────────────────────────────

const PROFILE_ID = 'profile-1';
const USER_ID = 'user-1';
const CERT_ID = 'a0000000-0000-4000-8000-000000000001';

const EXPERT_SESSION = {
  user: {
    onboardingCompleted: true,
    id: USER_ID,
    email: 'expert@example.com',
    activeMode: 'expert',
    expertProfileId: PROFILE_ID,
  },
  save: mockSave,
};

function validInput() {
  return {
    certifications: [{ certificationId: CERT_ID, earnedAt: '2024-01-01' }],
    trailheadUrl: 'https://trailhead.salesforce.com/en/users/jane',
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('saveCertificationsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
    mockSaveSettingsCertifications.mockResolvedValue({ outcome: 'saved' });
  });

  describe('authentication / mode guard', () => {
    it('throws when no session user', async () => {
      mockSessionObj = { save: mockSave };
      await expect(saveCertificationsAction(validInput())).rejects.toThrow('Unauthorized');
    });

    it('refuses when the active mode is not expert', async () => {
      mockSessionObj = {
        ...EXPERT_SESSION,
        user: { ...EXPERT_SESSION.user, activeMode: 'client' },
      };
      const result = await saveCertificationsAction(validInput());
      expect(result).toEqual({ success: false, error: 'Expert profile required' });
      expect(mockSaveSettingsCertifications).not.toHaveBeenCalled();
    });

    it('refuses when there is no expertProfileId', async () => {
      mockSessionObj = {
        ...EXPERT_SESSION,
        user: { ...EXPERT_SESSION.user, expertProfileId: undefined },
      };
      const result = await saveCertificationsAction(validInput());
      expect(result).toEqual({ success: false, error: 'Expert profile required' });
    });
  });

  describe('validation', () => {
    it('returns the first Zod issue message on invalid input', async () => {
      const result = await saveCertificationsAction({
        certifications: [{ certificationId: 'not-a-uuid' }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(mockSaveSettingsCertifications).not.toHaveBeenCalled();
    });
  });

  describe('outcome mapping', () => {
    it('maps locked to code "locked" and logs a warning', async () => {
      mockSaveSettingsCertifications.mockResolvedValue({ outcome: 'locked' });
      const result = await saveCertificationsAction(validInput());
      expect(result).toEqual({
        success: false,
        code: 'locked',
        error: CERTIFICATIONS_LOCKED_ERROR,
      });
      expect(log.warn).toHaveBeenCalledWith('Locked certification change refused', {
        expertProfileId: PROFILE_ID,
        userId: USER_ID,
      });
    });

    it('maps not_found to the generic failure', async () => {
      mockSaveSettingsCertifications.mockResolvedValue({ outcome: 'not_found' });
      const result = await saveCertificationsAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Failed to save certifications. Please try again.',
      });
    });

    it('maps saved to success, logs, and revalidates the settings path', async () => {
      const result = await saveCertificationsAction(validInput());
      expect(result).toEqual({ success: true });
      expect(log.info).toHaveBeenCalledWith(
        'Certifications saved',
        expect.objectContaining({ expertProfileId: PROFILE_ID, userId: USER_ID })
      );
      expect(revalidatePath).toHaveBeenCalledWith('/expert/settings');
    });

    it('passes the cert list and a null trailheadUrl when none is given', async () => {
      await saveCertificationsAction({
        certifications: [{ certificationId: CERT_ID }],
      });
      expect(mockSaveSettingsCertifications).toHaveBeenCalledWith(PROFILE_ID, {
        certs: [{ certificationId: CERT_ID }],
        trailheadUrl: null,
      });
    });
  });

  describe('error handling', () => {
    it('logs and returns the generic failure when the repository throws', async () => {
      mockSaveSettingsCertifications.mockRejectedValue(new Error('DB error'));
      const result = await saveCertificationsAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Failed to save certifications. Please try again.',
      });
      expect(log.error).toHaveBeenCalled();
    });
  });
});
