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

const mockInternalApiFetch = vi.fn();
vi.mock('../_lib/internal-api', () => ({
  internalApiFetch: (...args: unknown[]) => mockInternalApiFetch(...args),
}));

import { getScheduleAction } from './get-schedule';
import { log } from '@/lib/logging';

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

const SCHEDULE = {
  timezone: 'Australia/Melbourne',
  bookingSettings: {
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    windowDays: 60,
  },
  rules: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
};

describe('getScheduleAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when there is no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(getScheduleAction()).rejects.toThrow('Unauthorized');
  });

  it('returns null when not in expert mode', async () => {
    mockSessionObj = {
      user: { ...EXPERT_SESSION.user, activeMode: 'client' },
      save: mockSave,
    };
    expect(await getScheduleAction()).toBeNull();
    expect(mockInternalApiFetch).not.toHaveBeenCalled();
  });

  it('returns null when there is no expert profile', async () => {
    mockSessionObj = {
      user: { ...EXPERT_SESSION.user, expertProfileId: undefined },
      save: mockSave,
    };
    expect(await getScheduleAction()).toBeNull();
  });

  it('sends only the session-derived expertProfileId and returns the schedule', async () => {
    mockInternalApiFetch.mockResolvedValueOnce(SCHEDULE);

    const result = await getScheduleAction();

    expect(result).toEqual({ ...SCHEDULE, expertProfileId: 'profile-1' });
    expect(mockInternalApiFetch).toHaveBeenCalledWith(
      '/api/experts/profile-1/schedule',
      {},
      'schedule-api'
    );
  });

  it('returns null and logs on API failure', async () => {
    mockInternalApiFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await getScheduleAction();

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });
});
