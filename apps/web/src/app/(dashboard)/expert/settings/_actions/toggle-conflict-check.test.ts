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

import { toggleConflictCheckAction } from './toggle-conflict-check';

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

describe('toggleConflictCheckAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(
      toggleConflictCheckAction({
        subCalendarId: 'cal-1',
        conflictChecking: true,
        provider: 'google',
      })
    ).rejects.toThrow('Unauthorized');
  });

  it('returns success when API call succeeds', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({ success: true });
    const result = await toggleConflictCheckAction({
      subCalendarId: 'cal-1',
      conflictChecking: true,
      provider: 'google',
    });
    expect(result).toEqual({ success: true });
    expect(mockCalendarApiFetch).toHaveBeenCalledWith('/api/calendar/toggle-conflict-check', {
      method: 'POST',
      body: JSON.stringify({
        expertProfileId: 'profile-1',
        calendarId: 'cal-1',
        conflictCheck: true,
      }),
    });
  });

  it('is NOT forwarded in the request body — provider is for logging/analytics only', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({ success: true });
    await toggleConflictCheckAction({
      subCalendarId: 'cal-1',
      conflictChecking: true,
      provider: 'microsoft',
    });
    const [, options] = mockCalendarApiFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(options.body)).not.toHaveProperty('provider');
  });

  it('is included in the info log context', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({ success: true });
    await toggleConflictCheckAction({
      subCalendarId: 'cal-1',
      conflictChecking: true,
      provider: 'microsoft',
    });
    const loggingModule = await import('@/lib/logging');
    expect(loggingModule.log.info).toHaveBeenCalledWith(
      'Calendar conflict check toggled',
      expect.objectContaining({ provider: 'microsoft' })
    );
  });

  it('returns error when no expert profile', async () => {
    mockSessionObj = {
      user: { id: 'user-1', onboardingCompleted: true, email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await toggleConflictCheckAction({
      subCalendarId: 'cal-1',
      conflictChecking: true,
      provider: 'google',
    });
    expect(result).toEqual({ success: false, error: 'No expert profile found' });
  });

  // BAL-397 fix round (security WARNING) — a fixed literal reaches the browser; the real
  // error stays in `log.error`. See `disconnect-calendar.ts` for the four leaking classes.
  it('returns a generic error, never the raw internal error text, when the API call fails', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(
      new Error('INTERNAL_API_SECRET is not set — cannot authenticate internal API calls')
    );
    const result = await toggleConflictCheckAction({
      subCalendarId: 'cal-1',
      conflictChecking: false,
      provider: 'google',
    });
    expect(result).toEqual({ success: false, error: 'Failed to toggle conflict check' });
    expect(result.error).not.toContain('INTERNAL_API_SECRET');
  });
});
