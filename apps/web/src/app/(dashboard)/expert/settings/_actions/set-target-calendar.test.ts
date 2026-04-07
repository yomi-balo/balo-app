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

import { setTargetCalendarAction } from './set-target-calendar';

const EXPERT_SESSION = {
  user: {
    id: 'user-1',
    email: 'expert@example.com',
    activeMode: 'expert',
    expertProfileId: 'profile-1',
  },
  save: mockSave,
};

describe('setTargetCalendarAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(setTargetCalendarAction({ targetCalendarId: 'cal-1' })).rejects.toThrow(
      'Unauthorized'
    );
  });

  it('returns stub error for authenticated user', async () => {
    const result = await setTargetCalendarAction({ targetCalendarId: 'cal-1' });
    expect(result).toEqual({
      success: false,
      error: 'Calendar integration is not yet available.',
    });
  });
});
