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
    onboardingCompleted: true,
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
    await expect(disconnectCalendarAction({ provider: 'google' })).rejects.toThrow('Unauthorized');
  });

  it('sends provider in the POST body', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({ success: true });
    const result = await disconnectCalendarAction({ provider: 'microsoft' });
    expect(result).toEqual({ success: true });
    expect(mockCalendarApiFetch).toHaveBeenCalledWith('/api/calendar/disconnect', {
      method: 'POST',
      body: JSON.stringify({ expertProfileId: 'profile-1', provider: 'microsoft' }),
    });
  });

  it('returns error when no expert profile', async () => {
    mockSessionObj = {
      user: { id: 'user-1', onboardingCompleted: true, email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await disconnectCalendarAction({ provider: 'google' });
    expect(result).toEqual({ success: false, error: 'No expert profile found' });
  });

  // BAL-397 fix round (security WARNING) — the browser gets a fixed literal; the real error
  // stays in `log.error`. `internalApiFetch` can throw an undici network error naming the
  // internal API's private host/IP/port, or the literal name of the INTERNAL_API_SECRET env
  // var — neither may reach a Sonner toast.
  it('returns a generic error, never the raw internal error text, when the API call fails', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.0.7:3002 — INTERNAL_API_SECRET is not set')
    );
    const result = await disconnectCalendarAction({ provider: 'google' });
    expect(result).toEqual({ success: false, error: 'Failed to disconnect calendar' });
    expect(result.error).not.toContain('ECONNREFUSED');
    expect(result.error).not.toContain('INTERNAL_API_SECRET');
  });

  // BAL-397 fix round (security WARNING) — `DisconnectCalendarInput` is erased at runtime and
  // Server Actions are directly POST-able, so an omitted `provider` used to reach the API's
  // whole-account "disconnect ALL" arm.
  describe('provider validation (the disconnect-all escalation)', () => {
    it('rejects an omitted provider instead of escalating to disconnect-all', async () => {
      const result = await disconnectCalendarAction(
        {} as unknown as { provider: 'google' | 'microsoft' }
      );
      expect(result).toEqual({ success: false, error: 'Failed to disconnect calendar' });
      expect(mockCalendarApiFetch).not.toHaveBeenCalled();
    });

    it('rejects an unknown provider string', async () => {
      const result = await disconnectCalendarAction({
        provider: 'apple',
      } as unknown as { provider: 'google' | 'microsoft' });
      expect(result.success).toBe(false);
      expect(mockCalendarApiFetch).not.toHaveBeenCalled();
    });
  });
});
