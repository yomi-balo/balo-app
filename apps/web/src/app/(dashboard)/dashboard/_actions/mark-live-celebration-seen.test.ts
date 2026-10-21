import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const mockFindApprovalById = vi.fn();
const mockMarkSeen = vi.fn();
vi.mock('@balo/db', () => ({
  expertsRepository: {
    findApprovalById: (...args: unknown[]) => mockFindApprovalById(...args),
    markLiveCelebrationSeen: (...args: unknown[]) => mockMarkSeen(...args),
  },
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...args: unknown[]) => mockTrack(...args),
  EXPERT_SETUP_SERVER_EVENTS: { LIVE_CELEBRATION_VIEWED: 'expert_live_celebration_viewed' },
}));

import { markLiveCelebrationSeenAction } from './mark-live-celebration-seen';
import { log } from '@/lib/logging';
import { APPROVED_PROFILE_ROW } from '@/test/fixtures/approved-expert-gate-cases';

const EXPERT_USER = {
  onboardingCompleted: true,
  id: 'user-1',
  email: 'expert@example.com',
  activeMode: 'expert',
  expertProfileId: 'profile-1',
};

describe('markLiveCelebrationSeenAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { ...EXPERT_USER }, save: mockSave };
    mockFindApprovalById.mockResolvedValue(APPROVED_PROFILE_ROW);
    mockMarkSeen.mockResolvedValue(true);
  });

  it('stamps the session-derived profile and fires the event once with distinct_id', async () => {
    const result = await markLiveCelebrationSeenAction();

    expect(result).toEqual({ stamped: true });
    expect(mockMarkSeen).toHaveBeenCalledWith({ expertProfileId: 'profile-1', userId: 'user-1' });
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('expert_live_celebration_viewed', {
      expert_id: 'profile-1',
      distinct_id: 'user-1',
    });
    expect(log.info).toHaveBeenCalledWith('Expert live celebration seen', {
      expertProfileId: 'profile-1',
    });
  });

  it('fires no event when the stamp was already set', async () => {
    mockMarkSeen.mockResolvedValue(false);
    const result = await markLiveCelebrationSeenAction();
    expect(result).toEqual({ stamped: false });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('never writes under an impersonated session', async () => {
    mockSessionObj = { user: { ...EXPERT_USER, isImpersonating: true }, save: mockSave };
    const result = await markLiveCelebrationSeenAction();
    expect(result).toEqual({ stamped: false });
    expect(mockMarkSeen).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('never writes for an unapproved expert', async () => {
    mockFindApprovalById.mockResolvedValue({ ...APPROVED_PROFILE_ROW, approvedAt: null });
    const result = await markLiveCelebrationSeenAction();
    expect(result).toEqual({ stamped: false });
    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('returns stamped:false and logs when the repository throws', async () => {
    mockMarkSeen.mockRejectedValue(new Error('DB down'));
    const result = await markLiveCelebrationSeenAction();
    expect(result).toEqual({ stamped: false });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to mark live celebration seen',
      expect.objectContaining({ error: 'DB down' })
    );
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
