import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

vi.mock('server-only', () => ({}));

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: mockLogError, warn: vi.fn() },
}));

const mockCalendarApiFetch = vi.fn();
vi.mock('../_lib/calendar-api', () => ({
  calendarApiFetch: (...args: unknown[]) => mockCalendarApiFetch(...args),
}));

import { getTimezoneImpactAction } from './get-timezone-impact';

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

const REPORT = {
  timezone: 'Europe/London',
  affectedCount: 1,
  truncated: false,
  affected: [
    {
      consultationId: 'c1',
      startAt: '2026-12-24T03:00:00.000Z',
      endAt: '2026-12-24T04:00:00.000Z',
      clientCompanyName: 'Northwind Industrial',
    },
  ],
  nextTimeOff: { startDate: '2026-12-24', endDate: '2027-01-02' },
};

describe('getTimezoneImpactAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when there is no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(getTimezoneImpactAction({ timezone: 'Europe/London' })).rejects.toThrow(
      'Unauthorized'
    );
  });

  it('returns null without a fetch when the session has no expert profile', async () => {
    mockSessionObj = { user: { ...EXPERT_SESSION.user, expertProfileId: undefined } };

    expect(await getTimezoneImpactAction({ timezone: 'Europe/London' })).toBeNull();
    expect(mockCalendarApiFetch).not.toHaveBeenCalled();
  });

  it('returns null without a fetch for an invalid zone', async () => {
    expect(await getTimezoneImpactAction({ timezone: 'Not/AZone' })).toBeNull();
    expect(mockCalendarApiFetch).not.toHaveBeenCalled();
  });

  it('asks the route with the session ids and the proposed zone, and returns its report', async () => {
    mockCalendarApiFetch.mockResolvedValue(REPORT);

    const result = await getTimezoneImpactAction({ timezone: 'Europe/London' });

    expect(result).toEqual(REPORT);
    expect(mockCalendarApiFetch).toHaveBeenCalledTimes(1);
    const [url] = mockCalendarApiFetch.mock.calls[0] as [string];
    const [path, query] = url.split('?');
    expect(path).toBe('/api/experts/timezone-impact');
    const params = new URLSearchParams(query);
    expect(params.get('expertProfileId')).toBe('profile-1');
    expect(params.get('userId')).toBe('user-1');
    expect(params.get('timezone')).toBe('Europe/London');
  });

  it('fails open: a thrown fetch returns null and logs the error', async () => {
    mockCalendarApiFetch.mockRejectedValue(new Error('boom'));

    expect(await getTimezoneImpactAction({ timezone: 'Europe/London' })).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to check timezone impact',
      expect.objectContaining({ userId: 'user-1', expertProfileId: 'profile-1', error: 'boom' })
    );
  });
});
