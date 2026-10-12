import { describe, it, expect, vi, beforeEach } from 'vitest';

// BAL-568 — the seams re-read the LIVE `users` row; this suite is not about that gate.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockLoggedFetch = vi.fn();
vi.mock('@/lib/logging/fetch-wrapper', () => ({
  loggedFetch: (...args: unknown[]) => mockLoggedFetch(...args),
}));

const mockFindProfileById = vi.fn();
const mockFindByExpertProfileId = vi.fn();
const mockUpsertPayoutDetails = vi.fn();
const mockUpdateBeneficiaryStatus = vi.fn();

vi.mock('@balo/db', () => ({
  expertsRepository: {
    findProfileById: (...args: unknown[]) => mockFindProfileById(...args),
  },
  payoutsRepository: {
    findByExpertProfileId: (...args: unknown[]) => mockFindByExpertProfileId(...args),
    upsertPayoutDetails: (...args: unknown[]) => mockUpsertPayoutDetails(...args),
    updateBeneficiaryStatus: (...args: unknown[]) => mockUpdateBeneficiaryStatus(...args),
  },
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { savePayoutDetailsAction } from './save-payout-details';
import {
  APPROVED_PROFILE_ROW,
  itEnforcesApprovedExpertGate,
} from '@/test/fixtures/approved-expert-gate-cases';

const EXPERT_SESSION = {
  user: {
    onboardingCompleted: true,
    id: 'user-1',
    email: 'expert@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    activeMode: 'expert',
    expertProfileId: 'profile-1',
  },
  save: mockSave,
};

const INPUT = {
  countryCode: 'AU',
  currency: 'AUD',
  transferMethod: 'LOCAL',
  entityType: 'PERSONAL',
  formValues: { 'beneficiary.first_name': 'Jane' },
};

describe('savePayoutDetailsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('INTERNAL_API_SECRET', '');
    mockSessionObj = { ...EXPERT_SESSION };
    mockFindProfileById.mockResolvedValue(APPROVED_PROFILE_ROW);
    mockFindByExpertProfileId.mockResolvedValue(undefined);
    mockUpsertPayoutDetails.mockResolvedValue(undefined);
    mockUpdateBeneficiaryStatus.mockResolvedValue(undefined);
  });

  it('throws when there is no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(savePayoutDetailsAction(INPUT)).rejects.toThrow('Unauthorized');
  });

  describe('approved expert guard', () => {
    itEnforcesApprovedExpertGate({
      setSessionUser: (u) => {
        mockSessionObj = {
          ...EXPERT_SESSION,
          user: { ...EXPERT_SESSION.user, ...u, expertProfileId: u.expertProfileId ?? undefined },
        };
      },
      setProfileRow: (row) => mockFindProfileById.mockResolvedValue(row),
      findProfileById: mockFindProfileById,
      run: () => savePayoutDetailsAction(INPUT),
      expectAllowed: (result) => expect(result).toEqual(expect.objectContaining({ success: true })),
      expectRefused: (result) =>
        expect(result).toEqual({ success: false, error: 'Expert profile required' }),
      expectNoSideEffect: () => expect(mockUpsertPayoutDetails).not.toHaveBeenCalled(),
    });

    it('returns the generic failure, without throwing, when the guard read fails', async () => {
      mockFindProfileById.mockRejectedValue(new Error('DB down'));
      const result = await savePayoutDetailsAction(INPUT);
      expect(result).toEqual({
        success: false,
        error: 'Failed to save payout details. Please try again.',
      });
      expect(mockUpsertPayoutDetails).not.toHaveBeenCalled();
    });
  });

  describe('persistence', () => {
    it('upserts payout details against the guard-resolved profile id', async () => {
      const result = await savePayoutDetailsAction(INPUT);

      expect(mockUpsertPayoutDetails).toHaveBeenCalledWith(
        'profile-1',
        expect.objectContaining({
          countryCode: 'AU',
          currency: 'AUD',
          formValues: { 'beneficiary.first_name': 'Jane' },
        })
      );
      expect(result).toEqual({
        success: true,
        maskedFormValues: { 'beneficiary.first_name': 'Jane' },
        tradingName: null,
        beneficiaryStatus: 'pending_verification',
      });
      expect(mockUpdateBeneficiaryStatus).toHaveBeenCalledWith('profile-1', {
        beneficiaryStatus: 'pending_verification',
      });
    });

    it('rejects invalid input before reading the profile', async () => {
      const result = await savePayoutDetailsAction({ ...INPUT, countryCode: 'AUS' });
      expect(result).toEqual({ success: false, error: 'Country code must be 2 characters' });
      expect(mockFindProfileById).not.toHaveBeenCalled();
    });
  });
});
