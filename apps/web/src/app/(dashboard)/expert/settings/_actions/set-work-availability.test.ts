import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const mockInternalApiFetch = vi.fn();
vi.mock('../_lib/internal-api', () => ({
  internalApiFetch: (...args: unknown[]) => mockInternalApiFetch(...args),
}));

import { setWorkAvailabilityAction } from './set-work-availability';
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

describe('setWorkAvailabilityAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { ...EXPERT_SESSION };
  });

  it('throws when there is no session user', async () => {
    mockSessionObj = { save: mockSave };
    await expect(setWorkAvailabilityAction({ availableForWork: false })).rejects.toThrow(
      'Unauthorized'
    );
  });

  it('returns an error when not in expert mode', async () => {
    mockSessionObj = { user: { ...EXPERT_SESSION.user, activeMode: 'client' }, save: mockSave };
    const result = await setWorkAvailabilityAction({ availableForWork: false });
    expect(result).toEqual({ success: false, error: 'Expert profile required' });
    expect(mockInternalApiFetch).not.toHaveBeenCalled();
  });

  it('returns an error when the session has no expert profile', async () => {
    mockSessionObj = {
      user: { ...EXPERT_SESSION.user, expertProfileId: undefined },
      save: mockSave,
    };
    const result = await setWorkAvailabilityAction({ availableForWork: true });
    expect(result.success).toBe(false);
    expect(mockInternalApiFetch).not.toHaveBeenCalled();
  });

  it('PUTs to the session-derived profile path with the actor and revalidates', async () => {
    mockInternalApiFetch.mockResolvedValueOnce({ success: true });

    // A client-supplied id must be ignored: the path comes from the session.
    const result = await setWorkAvailabilityAction({
      availableForWork: false,
      expertProfileId: 'attacker-profile',
    } as { availableForWork: boolean });

    expect(result).toEqual({ success: true });
    expect(mockInternalApiFetch).toHaveBeenCalledWith(
      '/api/experts/profile-1/work-availability',
      {
        method: 'PUT',
        body: JSON.stringify({ availableForWork: false, actorUserId: 'user-1' }),
      },
      'schedule-api'
    );
    expect(revalidatePath).toHaveBeenCalledWith('/expert/settings');
    expect(revalidatePath).toHaveBeenCalledWith('/expert/calendar');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard');
    expect(log.info).toHaveBeenCalledWith(
      'Expert work availability changed',
      expect.objectContaining({ expertProfileId: 'profile-1', availableForWork: false })
    );
  });

  it('rejects a non-boolean input without calling the API', async () => {
    const result = await setWorkAvailabilityAction({
      availableForWork: 'nope',
    } as unknown as { availableForWork: boolean });

    expect(result.success).toBe(false);
    expect(mockInternalApiFetch).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it('logs and returns a friendly error on API failure, without revalidating', async () => {
    mockInternalApiFetch.mockRejectedValueOnce(new Error('boom'));

    const result = await setWorkAvailabilityAction({ availableForWork: true });

    expect(result).toEqual({
      success: false,
      error: 'Failed to update availability. Please try again.',
    });
    expect(log.error).toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
