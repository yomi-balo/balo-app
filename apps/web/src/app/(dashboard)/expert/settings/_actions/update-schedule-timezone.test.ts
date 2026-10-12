import { describe, it, expect, vi, beforeEach } from 'vitest';

// BAL-568 — the seams re-read the LIVE `users` row; this suite is not about that gate.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

vi.mock('server-only', () => ({}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const mockFindProfileById = vi.fn();
vi.mock('@balo/db', () => ({
  expertsRepository: {
    findProfileById: (...args: unknown[]) => mockFindProfileById(...args),
  },
}));

const mockInternalApiFetch = vi.fn();
vi.mock('../_lib/internal-api', () => ({
  internalApiFetch: (...args: unknown[]) => mockInternalApiFetch(...args),
}));

import { updateScheduleTimezoneAction } from './update-schedule-timezone';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';
import {
  APPROVED_PROFILE_ROW,
  itEnforcesApprovedExpertGate,
} from '@/test/fixtures/approved-expert-gate-cases';

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

describe('updateScheduleTimezoneAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
    mockFindProfileById.mockResolvedValue(APPROVED_PROFILE_ROW);
  });

  it('throws when there is no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(updateScheduleTimezoneAction('Australia/Sydney')).rejects.toThrow('Unauthorized');
  });

  describe('approved expert guard', () => {
    itEnforcesApprovedExpertGate({
      setSessionUser: (u) => {
        mockSessionObj = {
          user: { ...EXPERT_SESSION.user, ...u, expertProfileId: u.expertProfileId ?? undefined },
          save: mockSave,
        };
      },
      setProfileRow: (row) => mockFindProfileById.mockResolvedValue(row),
      findProfileById: mockFindProfileById,
      run: () => {
        mockInternalApiFetch.mockResolvedValue({ success: true });
        return updateScheduleTimezoneAction('Australia/Sydney');
      },
      expectAllowed: (result) => {
        expect(result).toEqual({ success: true });
        expect(mockInternalApiFetch).toHaveBeenCalledTimes(1);
      },
      expectRefused: (result) =>
        expect(result).toEqual({ success: false, error: 'Expert profile required' }),
      expectNoSideEffect: () => expect(mockInternalApiFetch).not.toHaveBeenCalled(),
    });

    it('returns the generic failure, without throwing, when the guard read fails', async () => {
      mockFindProfileById.mockRejectedValue(new Error('DB down'));
      const result = await updateScheduleTimezoneAction('Australia/Sydney');
      expect(result).toEqual({
        success: false,
        error: 'Failed to update timezone. Please try again.',
      });
      expect(mockInternalApiFetch).not.toHaveBeenCalled();
    });
  });

  it('PATCHes the session-derived timezone path and revalidates', async () => {
    mockInternalApiFetch.mockResolvedValueOnce({ success: true });

    const result = await updateScheduleTimezoneAction('Australia/Sydney');

    expect(result).toEqual({ success: true });
    expect(mockInternalApiFetch).toHaveBeenCalledWith(
      '/api/experts/profile-1/timezone',
      {
        method: 'PATCH',
        body: JSON.stringify({ timezone: 'Australia/Sydney', actorUserId: 'user-1' }),
      },
      'schedule-api'
    );
    expect(revalidatePath).toHaveBeenCalledWith('/expert/settings');
    expect(log.info).toHaveBeenCalled();
  });

  it('rejects an invalid timezone before calling the API', async () => {
    const result = await updateScheduleTimezoneAction('Not/AZone');
    expect(result.success).toBe(false);
    expect(mockInternalApiFetch).not.toHaveBeenCalled();
  });

  it('returns an error and logs when the API call fails', async () => {
    mockInternalApiFetch.mockRejectedValueOnce(new Error('boom'));
    const result = await updateScheduleTimezoneAction('Australia/Sydney');
    expect(result.success).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });
});
