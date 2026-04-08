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

import { toggleConflictCheckAction } from './toggle-conflict-check';

const EXPERT_SESSION = {
  user: {
    id: 'user-1',
    email: 'expert@example.com',
    activeMode: 'expert',
    expertProfileId: 'profile-1',
  },
  save: mockSave,
};

describe('toggleConflictCheckAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(
      toggleConflictCheckAction({ subCalendarId: 'cal-1', conflictChecking: true })
    ).rejects.toThrow('Unauthorized');
  });

  it('returns stub error for authenticated user', async () => {
    const result = await toggleConflictCheckAction({
      subCalendarId: 'cal-1',
      conflictChecking: true,
    });
    expect(result).toEqual({
      success: false,
      error: 'Calendar integration is not yet available.',
    });
  });
});
