import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const mockFindApprovalById = vi.fn();
vi.mock('@balo/db', () => ({
  expertsRepository: {
    findApprovalById: (...args: unknown[]) => mockFindApprovalById(...args),
  },
}));

const mockInternalApiFetch = vi.fn();
vi.mock('../_lib/internal-api', () => ({
  internalApiFetch: (...args: unknown[]) => mockInternalApiFetch(...args),
}));

import { setWorkAvailabilityAction } from './set-work-availability';
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

describe('setWorkAvailabilityAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
    mockFindApprovalById.mockResolvedValue(APPROVED_PROFILE_ROW);
  });

  it('throws when there is no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(setWorkAvailabilityAction({ availableForWork: false })).rejects.toThrow(
      'Unauthorized'
    );
  });

  describe('approved expert guard', () => {
    itEnforcesApprovedExpertGate({
      setSessionUser: (u) => {
        mockSessionObj = {
          user: { ...EXPERT_SESSION.user, ...u, expertProfileId: u.expertProfileId ?? undefined },
          save: mockSave,
        };
      },
      setProfileRow: (row) => mockFindApprovalById.mockResolvedValue(row),
      findApprovalById: mockFindApprovalById,
      run: () => {
        mockInternalApiFetch.mockResolvedValue({ success: true });
        return setWorkAvailabilityAction({ availableForWork: false });
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
      mockFindApprovalById.mockRejectedValue(new Error('DB down'));
      const result = await setWorkAvailabilityAction({ availableForWork: false });
      expect(result).toEqual({
        success: false,
        error: 'Failed to update availability. Please try again.',
      });
      expect(mockInternalApiFetch).not.toHaveBeenCalled();
    });
  });

  it('PUTs to the session-derived profile path with the actor and revalidates', async () => {
    mockInternalApiFetch.mockResolvedValueOnce({ success: true });

    // A client-supplied id must be ignored: the path comes from the session.
    const result = await setWorkAvailabilityAction({
      availableForWork: false,
      expertProfileId: 'attacker-profile',
    } as { availableForWork: boolean });

    expect(result).toEqual({ success: true });
    expect(mockInternalApiFetch).toHaveBeenCalledWith(
      '/api/experts/profile-1/work-availability',
      {
        method: 'PUT',
        body: JSON.stringify({ availableForWork: false, actorUserId: 'user-1' }),
      },
      'schedule-api'
    );
    expect(revalidatePath).toHaveBeenCalledWith('/expert/settings');
    expect(revalidatePath).toHaveBeenCalledWith('/expert/calendar');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard');
    expect(log.info).toHaveBeenCalledWith(
      'Expert work availability changed',
      expect.objectContaining({ expertProfileId: 'profile-1', availableForWork: false })
    );
  });

  it('rejects a non-boolean input without calling the API', async () => {
    const result = await setWorkAvailabilityAction({
      availableForWork: 'nope',
    } as unknown as { availableForWork: boolean });

    expect(result.success).toBe(false);
    expect(mockInternalApiFetch).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it('logs and returns a friendly error on API failure, without revalidating', async () => {
    mockInternalApiFetch.mockRejectedValueOnce(new Error('boom'));

    const result = await setWorkAvailabilityAction({ availableForWork: true });

    expect(result).toEqual({
      success: false,
      error: 'Failed to update availability. Please try again.',
    });
    expect(log.error).toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
