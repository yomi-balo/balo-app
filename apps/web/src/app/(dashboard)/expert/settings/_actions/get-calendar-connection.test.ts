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

import { getCalendarConnectionAction } from './get-calendar-connection';

const EXPERT_SESSION = {
  user: {
    id: 'user-1',
    email: 'expert@example.com',
    activeMode: 'expert',
    expertProfileId: 'profile-1',
  },
  save: mockSave,
};

describe('getCalendarConnectionAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(getCalendarConnectionAction()).rejects.toThrow('Unauthorized');
  });

  it('returns null when no expert profile', async () => {
    mockSessionObj = {
      user: { id: 'user-1', email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await getCalendarConnectionAction();
    expect(result).toBeNull();
  });

  it('returns connection data on success', async () => {
    const mockConnection = {
      status: 'connected',
      providerEmail: 'user@gmail.com',
      lastSyncedAt: '2024-01-01T00:00:00Z',
      targetCalendarId: 'cal-1',
      subCalendars: [],
    };
    mockCalendarApiFetch.mockResolvedValueOnce({ connection: mockConnection });

    const result = await getCalendarConnectionAction();

    expect(result).toEqual(mockConnection);
    expect(mockCalendarApiFetch).toHaveBeenCalledWith(
      '/api/calendar/connection?expertProfileId=profile-1'
    );
  });

  it('returns null when API call fails', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await getCalendarConnectionAction();

    expect(result).toBeNull();
  });

  it('returns null connection from API', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({ connection: null });

    const result = await getCalendarConnectionAction();

    expect(result).toBeNull();
  });
});
