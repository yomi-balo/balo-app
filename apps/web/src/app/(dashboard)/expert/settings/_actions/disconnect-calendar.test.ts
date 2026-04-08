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

import { disconnectCalendarAction } from './disconnect-calendar';

const EXPERT_SESSION = {
  user: {
    id: 'user-1',
    email: 'expert@example.com',
    activeMode: 'expert',
    expertProfileId: 'profile-1',
  },
  save: mockSave,
};

describe('disconnectCalendarAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(disconnectCalendarAction()).rejects.toThrow('Unauthorized');
  });

  it('returns success when API call succeeds', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({ success: true });
    const result = await disconnectCalendarAction();
    expect(result).toEqual({ success: true });
    expect(mockCalendarApiFetch).toHaveBeenCalledWith('/api/calendar/disconnect', {
      method: 'POST',
      body: JSON.stringify({ expertProfileId: 'profile-1' }),
    });
  });

  it('returns error when no expert profile', async () => {
    mockSessionObj = {
      user: { id: 'user-1', email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await disconnectCalendarAction();
    expect(result).toEqual({ success: false, error: 'No expert profile found' });
  });

  it('returns error when API call fails', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await disconnectCalendarAction();
    expect(result).toEqual({ success: false, error: 'Network error' });
  });
});
