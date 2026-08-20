import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

// `vi.mock` factories are hoisted ABOVE every top-level `const` in this file — including
// past the real `import { getOverrideConflictsAction } ...` below, which is itself hoisted
// per ES module semantics and triggers `@/lib/logging`'s mock factory the moment it loads.
// Any mock fn a factory body REFERENCES (not just returns inline) must therefore come from
// `vi.hoisted`, or the reference lands in that binding's temporal dead zone.
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

import { getOverrideConflictsAction } from './get-override-conflicts';

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
  conflictCount: 1,
  durationDays: 3,
  timezone: 'Australia/Sydney',
  truncated: false,
  conflicts: [
    {
      consultationId: 'c1',
      startAt: '2026-12-24T03:00:00.000Z',
      endAt: '2026-12-24T04:00:00.000Z',
      clientCompanyName: 'Northwind Industrial',
    },
  ],
};

describe('getOverrideConflictsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(
      getOverrideConflictsAction({ startDate: '2026-12-24', endDate: '2026-12-26' })
    ).rejects.toThrow('Unauthorized');
  });

  it('returns null when the session has no expert profile — no fetch attempted', async () => {
    mockSessionObj = {
      user: { id: 'user-1', onboardingCompleted: true, email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };

    const result = await getOverrideConflictsAction({
      startDate: '2026-12-24',
      endDate: '2026-12-26',
    });

    expect(result).toBeNull();
    expect(mockCalendarApiFetch).not.toHaveBeenCalled();
  });

  it('returns null on invalid input (endDate before startDate) — no fetch attempted', async () => {
    const result = await getOverrideConflictsAction({
      startDate: '2026-12-26',
      endDate: '2026-12-24',
    });

    expect(result).toBeNull();
    expect(mockCalendarApiFetch).not.toHaveBeenCalled();
  });

  it('returns the conflict report on success', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce(REPORT);

    const result = await getOverrideConflictsAction({
      startDate: '2026-12-24',
      endDate: '2026-12-26',
    });

    expect(result).toEqual(REPORT);
    expect(mockCalendarApiFetch).toHaveBeenCalledWith(
      '/api/experts/availability-overrides/conflicts?expertProfileId=profile-1&userId=user-1&startDate=2026-12-24&endDate=2026-12-26'
    );
  });

  it('FAIL-OPEN: returns null and logs when the API call throws', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await getOverrideConflictsAction({
      startDate: '2026-12-24',
      endDate: '2026-12-26',
    });

    expect(result).toBeNull();
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to check time-off conflicts',
      expect.objectContaining({ userId: 'user-1', expertProfileId: 'profile-1' })
    );
  });
});
