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

const mockSetCalendarConnectNonceCookie = vi.fn();
vi.mock('../_lib/calendar-connect-cookie', () => ({
  setCalendarConnectNonceCookie: (...args: unknown[]) => mockSetCalendarConnectNonceCookie(...args),
}));

import { fixCalendarPermissionsAction } from './fix-calendar-permissions';

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

describe('fixCalendarPermissionsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(fixCalendarPermissionsAction('google')).rejects.toThrow('Unauthorized');
  });

  it('returns error when no expert profile', async () => {
    mockSessionObj = {
      user: { id: 'user-1', onboardingCompleted: true, email: 'e@e.com', activeMode: 'expert' },
      save: mockSave,
    };
    const result = await fixCalendarPermissionsAction('google');
    expect(result).toEqual({ success: false, error: 'No expert profile found' });
  });

  it('returns relink URL on success — BAL-396 §8.5: POST /api/calendar/connect, field name kept as relinkUrl', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({
      authUrl: 'https://apiroc.example.com/oauth/authorize/abc',
      nonce: 'nonce-abc',
    });
    const result = await fixCalendarPermissionsAction('google');
    expect(result).toEqual({
      success: true,
      relinkUrl: 'https://apiroc.example.com/oauth/authorize/abc',
    });
    expect(mockCalendarApiFetch).toHaveBeenCalledWith('/api/calendar/connect', {
      method: 'POST',
      body: JSON.stringify({ expertProfileId: 'profile-1', provider: 'google' }),
    });
  });

  it('passes the provider argument through to the connect call', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({
      authUrl: 'https://apiroc.example.com/x',
      nonce: 'nonce-abc',
    });
    await fixCalendarPermissionsAction('microsoft');
    expect(mockCalendarApiFetch).toHaveBeenCalledWith('/api/calendar/connect', {
      method: 'POST',
      body: JSON.stringify({ expertProfileId: 'profile-1', provider: 'microsoft' }),
    });
  });

  it('binds the fix-permissions attempt to the browser via the CSRF nonce cookie (BAL-396 fix round, Finding 1 — "fix permissions" re-runs OAuth per §8.5)', async () => {
    mockCalendarApiFetch.mockResolvedValueOnce({
      authUrl: 'https://apiroc.example.com/oauth/authorize/abc',
      nonce: 'nonce-abc',
    });
    await fixCalendarPermissionsAction('google');
    expect(mockSetCalendarConnectNonceCookie).toHaveBeenCalledWith('nonce-abc', 'google');
  });

  it('returns error when API call fails', async () => {
    mockCalendarApiFetch.mockRejectedValueOnce(new Error('Connection not in sync_pending'));
    const result = await fixCalendarPermissionsAction('google');
    expect(result).toEqual({
      success: false,
      error: 'Failed to generate permission fix link',
    });
  });
});
