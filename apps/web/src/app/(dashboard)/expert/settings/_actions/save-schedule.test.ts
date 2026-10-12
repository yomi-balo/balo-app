import { describe, it, expect, vi, beforeEach } from 'vitest';

// BAL-568 — the seams re-read the LIVE `users` row; this suite is not about that gate.
vi.mock('@/lib/auth/live-user', async () => (await import('@/test/live-user-double')).mock);

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
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const mockFindApprovalById = vi.fn();
vi.mock('@balo/db', () => ({
  expertsRepository: {
    findApprovalById: (...args: unknown[]) => mockFindApprovalById(...args),
  },
}));

const mockInternalApiFetch = vi.fn();
vi.mock('../_lib/internal-api', () => ({
  internalApiFetch: (...args: unknown[]) => mockInternalApiFetch(...args),
}));

import { saveScheduleAction } from './save-schedule';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';
import {
  APPROVED_PROFILE_ROW,
  itEnforcesApprovedExpertGate,
} from '@/test/fixtures/approved-expert-gate-cases';

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

const VALID_INPUT = {
  timezone: 'Australia/Melbourne',
  bookingSettings: {
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 10,
    minimumNoticeMinutes: 240,
  },
  rules: [
    { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
    { dayOfWeek: 2, startTime: '09:00', endTime: '17:00' },
  ],
};

describe('saveScheduleAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
    mockFindApprovalById.mockResolvedValue(APPROVED_PROFILE_ROW);
  });

  it('throws when there is no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(saveScheduleAction(VALID_INPUT)).rejects.toThrow('Unauthorized');
  });

  describe('approved expert guard', () => {
    itEnforcesApprovedExpertGate({
      setSessionUser: (u) => {
        mockSessionObj = {
          user: { ...EXPERT_SESSION.user, ...u, expertProfileId: u.expertProfileId ?? undefined },
          save: mockSave,
        };
      },
      setProfileRow: (row) => mockFindApprovalById.mockResolvedValue(row),
      findApprovalById: mockFindApprovalById,
      run: () => {
        mockInternalApiFetch.mockResolvedValue({ success: true });
        return saveScheduleAction(VALID_INPUT);
      },
      expectAllowed: (result) => {
        expect(result).toEqual({ success: true });
        expect(mockInternalApiFetch).toHaveBeenCalledTimes(1);
      },
      expectRefused: (result) =>
        expect(result).toEqual({ success: false, error: 'Expert profile required' }),
      expectNoSideEffect: () => expect(mockInternalApiFetch).not.toHaveBeenCalled(),
    });

    it('returns the generic failure, without throwing, when the guard read fails', async () => {
      mockFindApprovalById.mockRejectedValue(new Error('DB down'));
      const result = await saveScheduleAction(VALID_INPUT);
      expect(result).toEqual({
        success: false,
        error: 'Failed to save schedule. Please try again.',
      });
      expect(mockInternalApiFetch).not.toHaveBeenCalled();
    });
  });

  it('POSTs to the session-derived profile path — never a client id — and revalidates', async () => {
    mockInternalApiFetch.mockResolvedValueOnce({ success: true });

    // A malicious client id in the body must be ignored (the path is session-derived).
    const result = await saveScheduleAction({
      ...VALID_INPUT,
      // @ts-expect-error — extra field is stripped by the schema, never forwarded.
      expertProfileId: 'attacker-profile',
    });

    expect(result).toEqual({ success: true });
    const [path, options, service] = mockInternalApiFetch.mock.calls[0] ?? [];
    expect(path).toBe('/api/experts/profile-1/schedule');
    expect(service).toBe('schedule-api');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body).not.toHaveProperty('expertProfileId');
    expect(body.timezone).toBe('Australia/Melbourne');
    expect(body.rules).toHaveLength(2);
    expect(revalidatePath).toHaveBeenCalledWith('/expert/settings');
    expect(log.info).toHaveBeenCalled();
  });

  it('rejects an invalid timezone before calling the API', async () => {
    const result = await saveScheduleAction({ ...VALID_INPUT, timezone: 'Not/AZone' });
    expect(result.success).toBe(false);
    expect(mockInternalApiFetch).not.toHaveBeenCalled();
  });

  it("accepts 'UTC' — the profile default that Intl.supportedValuesOf omits", async () => {
    mockInternalApiFetch.mockResolvedValueOnce({ success: true });
    const result = await saveScheduleAction({ ...VALID_INPUT, timezone: 'UTC' });
    expect(result).toEqual({ success: true });
    const [, options] = mockInternalApiFetch.mock.calls[0] ?? [];
    expect(JSON.parse(options.body).timezone).toBe('UTC');
  });

  it('rejects a non-15-minute time boundary', async () => {
    const result = await saveScheduleAction({
      ...VALID_INPUT,
      rules: [{ dayOfWeek: 1, startTime: '09:07', endTime: '17:00' }],
    });
    expect(result.success).toBe(false);
    expect(mockInternalApiFetch).not.toHaveBeenCalled();
  });

  it('returns an error and logs when the API call fails', async () => {
    mockInternalApiFetch.mockRejectedValueOnce(new Error('boom'));
    const result = await saveScheduleAction(VALID_INPUT);
    expect(result.success).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });

  it('forwards a rule that crosses midnight — the refine is transitive via scheduleRulesSchema', async () => {
    mockInternalApiFetch.mockResolvedValueOnce({ success: true });
    const crossingRule = { dayOfWeek: 1, startTime: '17:00', endTime: '09:00' };

    const result = await saveScheduleAction({ ...VALID_INPUT, rules: [crossingRule] });

    expect(result).toEqual({ success: true });
    const [, options] = mockInternalApiFetch.mock.calls[0] ?? [];
    expect(JSON.parse(options.body).rules[0]).toEqual(crossingRule);
  });

  it('rejects a rule whose start equals its end', async () => {
    const result = await saveScheduleAction({
      ...VALID_INPUT,
      rules: [{ dayOfWeek: 1, startTime: '09:00', endTime: '09:00' }],
    });
    expect(result.success).toBe(false);
    expect(mockInternalApiFetch).not.toHaveBeenCalled();
  });
});
