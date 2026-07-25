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

import { deleteAvailabilityOverrideAction } from './delete-availability-override';

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

describe('deleteAvailabilityOverrideAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(deleteAvailabilityOverrideAction({ overrideId: 'o1' })).rejects.toThrow(
      'Unauthorized'
    );
  });

  it('returns an error (no fetch) when the session has no expert profile', async () => {
    mockSessionObj = {
      user: { id: 'user-1', onboardingCompleted: true, email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await deleteAvailabilityOverrideAction({ overrideId: 'o1' });
    expect(result).toEqual({ success: false, error: 'No expert profile found' });
    expect(mockCalendarApiFetch).not.toHaveBeenCalled();
  });

  it('deletes the block, revalidates, and returns success', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({ success: true });

    const result = await deleteAvailabilityOverrideAction({ overrideId: 'o1' });

    expect(result).toEqual({ success: true });
    expect(mockCalendarApiFetch).toHaveBeenCalledWith(
      '/api/experts/availability-overrides/delete',
      {
        method: 'POST',
        body: JSON.stringify({ expertProfileId: 'profile-1', overrideId: 'o1' }),
      }
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith('/expert/settings');
  });

  it('surfaces the error (no revalidate) when the API call fails', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(new Error('Override not found'));

    const result = await deleteAvailabilityOverrideAction({ overrideId: 'o1' });

    expect(result).toEqual({ success: false, error: 'Override not found' });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
