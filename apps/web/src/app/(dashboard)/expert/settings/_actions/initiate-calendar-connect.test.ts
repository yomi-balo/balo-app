import { describe, it, expect, vi, beforeEach } from 'vitest';

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
}));

const mockCalendarApiFetch = vi.fn();
vi.mock('../_lib/calendar-api', () => ({
  calendarApiFetch: (...args: unknown[]) => mockCalendarApiFetch(...args),
}));

import { initiateCalendarConnectAction } from './initiate-calendar-connect';

const EXPERT_SESSION = {
  user: {
    id: 'user-1',
    email: 'expert@example.com',
    activeMode: 'expert',
    expertProfileId: 'profile-1',
  },
  save: mockSave,
};

describe('initiateCalendarConnectAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(initiateCalendarConnectAction('google')).rejects.toThrow('Unauthorized');
  });

  it('returns error when no expert profile', async () => {
    mockSessionObj = {
      user: { id: 'user-1', email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await initiateCalendarConnectAction('google');
    expect(result).toEqual({ success: false, error: 'No expert profile found' });
  });

  it('returns connectUrl on success', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({ authUrl: 'https://cronofy.com/auth/url' });

    const result = await initiateCalendarConnectAction('google');

    expect(result).toEqual({
      success: true,
      connectUrl: 'https://cronofy.com/auth/url',
    });
    expect(mockCalendarApiFetch).toHaveBeenCalledWith('/api/calendar/connect', {
      method: 'POST',
      body: JSON.stringify({ expertProfileId: 'profile-1', provider: 'google' }),
    });
  });

  it('returns error when API call fails', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await initiateCalendarConnectAction('microsoft');

    expect(result).toEqual({
      success: false,
      error: 'Failed to initiate calendar connection',
    });
  });
});
