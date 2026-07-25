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

import { clearScheduleAction } from './clear-schedule';
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

describe('clearScheduleAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when there is no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(clearScheduleAction()).rejects.toThrow('Unauthorized');
  });

  it('returns an error when not in expert mode', async () => {
    mockSessionObj = { user: { ...EXPERT_SESSION.user, activeMode: 'client' }, save: mockSave };
    const result = await clearScheduleAction();
    expect(result).toEqual({ success: false, error: 'Expert profile required' });
    expect(mockInternalApiFetch).not.toHaveBeenCalled();
  });

  it('DELETEs the session-derived profile path and revalidates', async () => {
    mockInternalApiFetch.mockResolvedValueOnce({ success: true });

    const result = await clearScheduleAction();

    expect(result).toEqual({ success: true });
    expect(mockInternalApiFetch).toHaveBeenCalledWith(
      '/api/experts/profile-1/schedule',
      { method: 'DELETE' },
      'schedule-api'
    );
    expect(revalidatePath).toHaveBeenCalledWith('/expert/settings');
    expect(log.info).toHaveBeenCalled();
  });

  it('returns an error and logs when the API call fails', async () => {
    mockInternalApiFetch.mockRejectedValueOnce(new Error('boom'));
    const result = await clearScheduleAction();
    expect(result.success).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });
});
