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

const mockInternalApiFetch = vi.fn();
vi.mock('../_lib/internal-api', () => ({
  internalApiFetch: (...args: unknown[]) => mockInternalApiFetch(...args),
}));

import { saveScheduleAction } from './save-schedule';
import { revalidatePath } from 'next/cache';
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
  });

  it('throws when there is no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(saveScheduleAction(VALID_INPUT)).rejects.toThrow('Unauthorized');
  });

  it('returns an error when not in expert mode', async () => {
    mockSessionObj = { user: { ...EXPERT_SESSION.user, activeMode: 'client' }, save: mockSave };
    const result = await saveScheduleAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Expert profile required' });
    expect(mockInternalApiFetch).not.toHaveBeenCalled();
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
});
