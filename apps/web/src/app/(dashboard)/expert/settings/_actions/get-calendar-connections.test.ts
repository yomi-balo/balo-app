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

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: mockLogError, warn: vi.fn() },
}));

const mockCalendarApiFetch = vi.fn();
vi.mock('../_lib/calendar-api', () => ({
  calendarApiFetch: (...args: unknown[]) => mockCalendarApiFetch(...args),
}));

import { getCalendarConnectionsAction } from './get-calendar-connections';

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

describe('getCalendarConnectionsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(getCalendarConnectionsAction()).rejects.toThrow('Unauthorized');
  });

  it('returns ok:true with an empty array when no expert profile — not an error', async () => {
    mockSessionObj = {
      user: { id: 'user-1', onboardingCompleted: true, email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await getCalendarConnectionsAction();
    expect(result).toEqual({ ok: true, connections: [] });
    expect(mockCalendarApiFetch).not.toHaveBeenCalled();
  });

  it('returns the array reached from the API', async () => {
    const connections = [
      {
        provider: 'google',
        credentialStatus: 'ACTIVE',
        providerEmail: 'user@gmail.com',
        lastSyncedAt: '2024-01-01T00:00:00Z',
        targetCalendarId: 'cal-1',
        subCalendars: [],
      },
    ];
    mockCalendarApiFetch.mockResolvedValueOnce({ connections });

    const result = await getCalendarConnectionsAction();

    expect(result).toEqual({ ok: true, connections });
    expect(mockCalendarApiFetch).toHaveBeenCalledWith(
      '/api/calendar/connection?expertProfileId=profile-1'
    );
  });

  it('returns ok:false (not an empty array) when the API call throws, and logs the underlying error', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await getCalendarConnectionsAction();

    expect(result).toEqual({ ok: false, error: 'Failed to load calendar connections' });
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to fetch calendar connections',
      expect.objectContaining({
        userId: 'user-1',
        expertProfileId: 'profile-1',
        error: 'Network error',
      })
    );
  });
});
