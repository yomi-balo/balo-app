import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockRevalidatePath = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

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

import { createAvailabilityOverrideAction } from './create-availability-override';

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

const VALID = { startDate: '2026-12-24', endDate: '2026-12-26', label: 'Holiday' };
const CREATED = { id: 'o1', startDate: '2026-12-24', endDate: '2026-12-26', label: 'Holiday' };

describe('createAvailabilityOverrideAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(createAvailabilityOverrideAction(VALID)).rejects.toThrow('Unauthorized');
  });

  it('rejects (no fetch) when the session has no expert profile', async () => {
    mockSessionObj = {
      user: { id: 'user-1', onboardingCompleted: true, email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await createAvailabilityOverrideAction(VALID);
    expect(result).toEqual({ success: false, error: 'No expert profile found' });
    expect(mockCalendarApiFetch).not.toHaveBeenCalled();
  });

  it('rejects (no fetch) when endDate is before startDate', async () => {
    const result = await createAvailabilityOverrideAction({
      startDate: '2026-12-26',
      endDate: '2026-12-24',
    });
    expect(result.success).toBe(false);
    expect(mockCalendarApiFetch).not.toHaveBeenCalled();
  });

  it('rejects (no fetch) when the label exceeds 80 characters', async () => {
    const result = await createAvailabilityOverrideAction({
      startDate: '2026-12-24',
      endDate: '2026-12-26',
      label: 'x'.repeat(81),
    });
    expect(result.success).toBe(false);
    expect(mockCalendarApiFetch).not.toHaveBeenCalled();
  });

  it('creates the block, revalidates, and returns the DTO on success', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({ override: CREATED });

    const result = await createAvailabilityOverrideAction(VALID);

    expect(result).toEqual({ success: true, override: CREATED });
    expect(mockCalendarApiFetch).toHaveBeenCalledWith('/api/experts/availability-overrides', {
      method: 'POST',
      body: JSON.stringify({
        expertProfileId: 'profile-1',
        startDate: '2026-12-24',
        endDate: '2026-12-26',
        label: 'Holiday',
      }),
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith('/expert/settings');
  });

  it('surfaces the error when the API call fails', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(new Error('Failed to create availability override'));

    const result = await createAvailabilityOverrideAction(VALID);

    expect(result).toEqual({
      success: false,
      error: 'Failed to create availability override',
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
