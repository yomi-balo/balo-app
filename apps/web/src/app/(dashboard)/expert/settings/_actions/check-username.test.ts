import { describe, it, expect, vi, beforeEach } from 'vitest';

// BAL-568 — the seams re-read the LIVE `users` row; this suite is not about that gate.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

vi.mock('server-only', () => ({}));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockFindApprovalById = vi.fn();
const mockCheckUsernameAvailability = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    findApprovalById: (...args: unknown[]) => mockFindApprovalById(...args),
    checkUsernameAvailability: (...args: unknown[]) => mockCheckUsernameAvailability(...args),
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { checkUsernameAction } from './check-username';
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

describe('checkUsernameAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
    mockFindApprovalById.mockResolvedValue(APPROVED_PROFILE_ROW);
    mockCheckUsernameAvailability.mockResolvedValue(true);
  });

  it('throws when there is no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(checkUsernameAction({ username: 'jane-doe' })).rejects.toThrow('Unauthorized');
  });

  describe('approved expert guard', () => {
    itEnforcesApprovedExpertGate({
      setSessionUser: (u) => {
        mockSessionObj = {
          ...EXPERT_SESSION,
          user: { ...EXPERT_SESSION.user, ...u, expertProfileId: u.expertProfileId ?? undefined },
        };
      },
      setProfileRow: (row) => mockFindApprovalById.mockResolvedValue(row),
      findApprovalById: mockFindApprovalById,
      run: () => checkUsernameAction({ username: 'jane-doe' }),
      expectAllowed: (result) => expect(result).toEqual({ available: true }),
      expectRefused: (result) =>
        expect(result).toEqual({ available: false, error: 'Expert profile required' }),
      expectNoSideEffect: () => expect(mockCheckUsernameAvailability).not.toHaveBeenCalled(),
    });

    it('returns the generic failure, without throwing, when the guard read fails', async () => {
      mockFindApprovalById.mockRejectedValue(new Error('DB down'));
      const result = await checkUsernameAction({ username: 'jane-doe' });
      expect(result).toEqual({
        available: false,
        error: 'Failed to check username. Please try again.',
      });
      expect(mockCheckUsernameAvailability).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledWith(
        'Failed to verify approved expert for username check',
        expect.objectContaining({ userId: 'user-1', error: 'DB down' })
      );
    });
  });

  describe('availability', () => {
    it('checks availability against the guard-resolved profile id', async () => {
      const result = await checkUsernameAction({ username: 'jane-doe' });
      expect(result).toEqual({ available: true });
      expect(mockCheckUsernameAvailability).toHaveBeenCalledWith('jane-doe', 'profile-1');
    });

    it('reports a taken username as unavailable', async () => {
      mockCheckUsernameAvailability.mockResolvedValue(false);
      expect(await checkUsernameAction({ username: 'jane-doe' })).toEqual({ available: false });
    });

    it('rejects a too-short username without reading the database', async () => {
      const result = await checkUsernameAction({ username: 'ab' });
      expect(result.available).toBe(false);
      expect(mockCheckUsernameAvailability).not.toHaveBeenCalled();
    });

    it('rejects a badly formatted username', async () => {
      const result = await checkUsernameAction({ username: 'Jane Doe!' });
      expect(result.available).toBe(false);
      expect(mockCheckUsernameAvailability).not.toHaveBeenCalled();
    });

    it('rejects a reserved username', async () => {
      const result = await checkUsernameAction({ username: 'admin' });
      expect(result).toEqual({ available: false, error: 'This username is reserved' });
    });

    it('returns a friendly error when the availability query fails', async () => {
      mockCheckUsernameAvailability.mockRejectedValue(new Error('boom'));
      const result = await checkUsernameAction({ username: 'jane-doe' });
      expect(result).toEqual({
        available: false,
        error: 'Unable to check username. Please try again.',
      });
    });
  });
});
