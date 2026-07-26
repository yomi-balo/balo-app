import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockCalendarApiFetch = vi.fn();
vi.mock('../_lib/calendar-api', () => ({
  calendarApiFetch: (...args: unknown[]) => mockCalendarApiFetch(...args),
}));

import { getAvailabilityOverridesAction } from './get-availability-overrides';

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

const SAMPLE = { id: 'o1', startDate: '2026-12-25', endDate: '2026-12-25', label: 'Holiday' };

describe('getAvailabilityOverridesAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(getAvailabilityOverridesAction()).rejects.toThrow('Unauthorized');
  });

  it('returns [] when the session has no expert profile', async () => {
    mockSessionObj = {
      user: { id: 'user-1', onboardingCompleted: true, email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await getAvailabilityOverridesAction();
    expect(result).toEqual([]);
    expect(mockCalendarApiFetch).not.toHaveBeenCalled();
  });

  it('returns the overrides list on success', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({ overrides: [SAMPLE] });

    const result = await getAvailabilityOverridesAction();

    expect(result).toEqual([SAMPLE]);
    expect(mockCalendarApiFetch).toHaveBeenCalledWith(
      '/api/experts/availability-overrides?expertProfileId=profile-1'
    );
  });

  it('returns [] when the API call fails (graceful read degradation)', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await getAvailabilityOverridesAction();

    expect(result).toEqual([]);
  });
});
