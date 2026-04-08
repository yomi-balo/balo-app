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

import { fixCalendarPermissionsAction } from './fix-calendar-permissions';

const EXPERT_SESSION = {
  user: {
    id: 'user-1',
    email: 'expert@example.com',
    activeMode: 'expert',
    expertProfileId: 'profile-1',
  },
  save: mockSave,
};

describe('fixCalendarPermissionsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(fixCalendarPermissionsAction()).rejects.toThrow('Unauthorized');
  });

  it('returns error when no expert profile', async () => {
    mockSessionObj = {
      user: { id: 'user-1', email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await fixCalendarPermissionsAction();
    expect(result).toEqual({ success: false, error: 'No expert profile found' });
  });

  it('returns relink URL on success', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({
      relinkUrl: 'https://app.cronofy.com/relink/abc',
    });
    const result = await fixCalendarPermissionsAction();
    expect(result).toEqual({
      success: true,
      relinkUrl: 'https://app.cronofy.com/relink/abc',
    });
    expect(mockCalendarApiFetch).toHaveBeenCalledWith(
      '/api/calendar/relink?expertProfileId=profile-1'
    );
  });

  it('returns error when API call fails', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(new Error('Connection not in sync_pending'));
    const result = await fixCalendarPermissionsAction();
    expect(result).toEqual({
      success: false,
      error: 'Failed to generate permission fix link',
    });
  });
});
