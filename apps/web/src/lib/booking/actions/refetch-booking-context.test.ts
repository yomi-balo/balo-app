import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireOnboardedUser = vi.fn();
const mockLoadBookingContext = vi.fn();
const mockLogWarn = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: (...args: unknown[]) => mockRequireOnboardedUser(...args),
}));
vi.mock('../load-booking-context', () => ({
  loadBookingContext: (...args: unknown[]) => mockLoadBookingContext(...args),
}));
vi.mock('@/lib/logging', () => ({
  log: { warn: (...args: unknown[]) => mockLogWarn(...args), error: vi.fn(), info: vi.fn() },
}));

import { refetchBookingContextAction } from './refetch-booking-context';

const USER = { id: 'user-1', onboardingCompleted: true };
const EXPERT_PROFILE_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(USER);
});

describe('refetchBookingContextAction', () => {
  it('always authenticates via requireOnboardedUser (the mutation gate)', async () => {
    mockLoadBookingContext.mockResolvedValue({ arm: 'onboarding_required' });
    await refetchBookingContextAction({ expertProfileId: EXPERT_PROFILE_ID });
    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed input before calling the loader, and logs it', async () => {
    const result = await refetchBookingContextAction({ expertProfileId: 'not-a-uuid' });
    expect(result).toEqual({ ok: false });
    expect(mockLoadBookingContext).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Booking context refetch rejected — invalid input',
      expect.objectContaining({ userId: 'user-1' })
    );
  });

  it('re-runs the loader for THIS user and re-serializes the result (single_company arm)', async () => {
    mockLoadBookingContext.mockResolvedValue({
      arm: 'single_company',
      company: { id: 'company-1', name: 'Northwind', logoUrl: null },
      resolvedCaseCount: 1,
      openCases: [
        {
          engagementId: 'engagement-1',
          title: 'Flow interview loop',
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          lastActivityAt: new Date('2026-06-01T00:00:00.000Z'),
          consultationCount: 2,
        },
      ],
      expert: { firstName: 'Dana', partyLabel: 'Dana Okoro' },
    });
    const result = await refetchBookingContextAction({ expertProfileId: EXPERT_PROFILE_ID });
    expect(mockLoadBookingContext).toHaveBeenCalledWith(EXPERT_PROFILE_ID, 'user-1');
    expect(result).toEqual({
      ok: true,
      context: {
        arm: 'single_company',
        company: { id: 'company-1', name: 'Northwind', logoUrl: null },
        resolvedCaseCount: 1,
        openCases: [
          {
            engagementId: 'engagement-1',
            title: 'Flow interview loop',
            createdAt: '2026-05-01T00:00:00.000Z',
            lastActivityAt: '2026-06-01T00:00:00.000Z',
            consultationCount: 2,
          },
        ],
      },
    });
  });

  it('re-serializes a choose_company arm, dropping the arm-carried expert field', async () => {
    mockLoadBookingContext.mockResolvedValue({
      arm: 'choose_company',
      companies: [
        { id: 'company-1', name: 'Northwind', logoUrl: null },
        { id: 'company-2', name: 'Acme', logoUrl: null },
      ],
      expert: { firstName: 'Dana', partyLabel: 'Dana Okoro' },
    });
    const result = await refetchBookingContextAction({ expertProfileId: EXPERT_PROFILE_ID });
    expect(result).toEqual({
      ok: true,
      context: {
        arm: 'choose_company',
        companies: [
          { id: 'company-1', name: 'Northwind', logoUrl: null },
          { id: 'company-2', name: 'Acme', logoUrl: null },
        ],
      },
    });
    expect(result.ok && 'expert' in result.context).toBe(false);
  });

  it('passes company_read_failed through unchanged', async () => {
    mockLoadBookingContext.mockResolvedValue({ arm: 'company_read_failed' });
    const result = await refetchBookingContextAction({ expertProfileId: EXPERT_PROFILE_ID });
    expect(result).toEqual({ ok: true, context: { arm: 'company_read_failed' } });
  });
});
