import { describe, it, expect, vi, beforeEach } from 'vitest';

// BAL-568 — the seams re-read the LIVE `users` row; this suite is not about that gate.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

vi.mock('server-only', () => ({}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const mockCountWorkInFlight = vi.fn();
vi.mock('@balo/db', () => ({
  expertsRepository: {
    countWorkInFlight: (...args: unknown[]) => mockCountWorkInFlight(...args),
  },
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
  },
  rules: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
  availableForWork: true,
};

const WORK_IN_FLIGHT = { upcomingConsultations: 2, activeProjects: 1 };

describe('getScheduleAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
    mockCountWorkInFlight.mockResolvedValue(WORK_IN_FLIGHT);
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

    expect(result).toEqual({
      ...SCHEDULE,
      expertProfileId: 'profile-1',
      workInFlight: WORK_IN_FLIGHT,
    });
    expect(mockCountWorkInFlight).toHaveBeenCalledWith('profile-1', expect.any(Date));
    expect(mockInternalApiFetch).toHaveBeenCalledWith(
      '/api/experts/profile-1/schedule',
      {},
      'schedule-api'
    );
  });

  it('returns the paused flag from the API', async () => {
    mockInternalApiFetch.mockResolvedValueOnce({ ...SCHEDULE, availableForWork: false });

    const result = await getScheduleAction();

    expect(result?.availableForWork).toBe(false);
  });

  it('falls back to zero counts and warns when the in-flight count fails', async () => {
    mockInternalApiFetch.mockResolvedValueOnce(SCHEDULE);
    mockCountWorkInFlight.mockRejectedValueOnce(new Error('db down'));

    const result = await getScheduleAction();

    expect(result).toEqual({
      ...SCHEDULE,
      expertProfileId: 'profile-1',
      workInFlight: { upcomingConsultations: 0, activeProjects: 0 },
    });
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('returns null and logs on API failure', async () => {
    mockInternalApiFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await getScheduleAction();

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });
});
