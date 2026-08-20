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
    onboardingCompleted: true,
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
    await expect(
      setTargetCalendarAction({ targetCalendarId: 'cal-1', provider: 'google' })
    ).rejects.toThrow('Unauthorized');
  });

  it('sends provider in the POST body', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({ success: true });
    const result = await setTargetCalendarAction({
      targetCalendarId: 'cal-1',
      provider: 'microsoft',
    });
    expect(result).toEqual({ success: true });
    expect(mockCalendarApiFetch).toHaveBeenCalledWith('/api/calendar/set-target-calendar', {
      method: 'POST',
      body: JSON.stringify({
        expertProfileId: 'profile-1',
        targetCalendarId: 'cal-1',
        provider: 'microsoft',
      }),
    });
  });

  it('returns error when no expert profile', async () => {
    mockSessionObj = {
      user: { id: 'user-1', onboardingCompleted: true, email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await setTargetCalendarAction({ targetCalendarId: 'cal-1', provider: 'google' });
    expect(result).toEqual({ success: false, error: 'No expert profile found' });
  });

  // BAL-397 fix round (security WARNING) — a fixed literal reaches the browser; the real
  // error stays in `log.error`. See `disconnect-calendar.ts` for the four leaking classes.
  it('returns a generic error, never the raw internal error text, when the API call fails', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.7:3002'));
    const result = await setTargetCalendarAction({ targetCalendarId: 'cal-1', provider: 'google' });
    expect(result).toEqual({ success: false, error: 'Failed to set target calendar' });
    expect(result.error).not.toContain('ECONNREFUSED');
  });
});
