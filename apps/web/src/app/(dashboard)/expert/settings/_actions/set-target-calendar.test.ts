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

import { setTargetCalendarAction } from './set-target-calendar';

const EXPERT_SESSION = {
  user: {
    id: 'user-1',
    email: 'expert@example.com',
    activeMode: 'expert',
    expertProfileId: 'profile-1',
  },
  save: mockSave,
};

describe('setTargetCalendarAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(setTargetCalendarAction({ targetCalendarId: 'cal-1' })).rejects.toThrow(
      'Unauthorized'
    );
  });

  it('returns success when API call succeeds', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({ success: true });
    const result = await setTargetCalendarAction({ targetCalendarId: 'cal-1' });
    expect(result).toEqual({ success: true });
    expect(mockCalendarApiFetch).toHaveBeenCalledWith('/api/calendar/set-target-calendar', {
      method: 'POST',
      body: JSON.stringify({
        expertProfileId: 'profile-1',
        targetCalendarId: 'cal-1',
      }),
    });
  });

  it('returns error when no expert profile', async () => {
    mockSessionObj = {
      user: { id: 'user-1', email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await setTargetCalendarAction({ targetCalendarId: 'cal-1' });
    expect(result).toEqual({ success: false, error: 'No expert profile found' });
  });

  it('returns error when API call fails', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(
      new Error('Calendar not found in connected sub-calendars')
    );
    const result = await setTargetCalendarAction({ targetCalendarId: 'cal-1' });
    expect(result).toEqual({
      success: false,
      error: 'Calendar not found in connected sub-calendars',
    });
  });
});
