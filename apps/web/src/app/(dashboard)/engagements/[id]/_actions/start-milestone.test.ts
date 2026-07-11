import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const MILESTONE_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: () => mockRequireUser() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...a: unknown[]) => mockResolveLens(...a),
}));

const {
  mockFindEngagement,
  mockFindOwner,
  mockStart,
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
} = vi.hoisted(() => {
  class EngagementNotActiveError extends Error {}
  class InvalidMilestoneTransitionError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockFindOwner: vi.fn(),
    mockStart: vi.fn(),
    EngagementNotActiveError,
    InvalidMilestoneTransitionError,
  };
});

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  companiesRepository: { findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
  engagementMilestonesRepository: { start: (...a: unknown[]) => mockStart(...a) },
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ENGAGEMENT_SERVER_EVENTS: {
    MILESTONE_STARTED: 'engagement_milestone_started',
    MILESTONE_COMPLETED: 'engagement_milestone_completed',
    MILESTONE_REVERTED: 'engagement_milestone_reverted',
  },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { startMilestoneAction } from './start-milestone';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const INPUT = { engagementId: ENGAGEMENT_ID, milestoneId: MILESTONE_ID };

function engagement(overrides: Record<string, unknown> = {}) {
  return {
    id: ENGAGEMENT_ID,
    status: 'active',
    activatedAt: new Date('2026-06-01T00:00:00Z'),
    createdAt: new Date('2026-05-01T00:00:00Z'),
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation' },
    expertProfile: {
      user: { firstName: 'Priya', lastName: 'Sharma' },
      agency: null,
      headline: null,
      type: 'freelancer',
    },
    milestones: [
      {
        id: MILESTONE_ID,
        title: 'Discovery',
        status: 'pending',
        startedAt: null,
        completedAt: null,
        completionNote: null,
        updatedAt: new Date('2026-06-01T00:00:00Z'),
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
  mockFindEngagement.mockResolvedValue(engagement());
  mockResolveLens.mockReturnValue({
    lens: 'expert',
    archetype: 'participant',
    isClientOwner: false,
    isDeliveringExpert: true,
  });
  mockStart.mockResolvedValue({
    id: MILESTONE_ID,
    status: 'in_progress',
    startedAt: new Date('2026-06-11T00:00:00Z'),
  });
});

describe('startMilestoneAction', () => {
  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await startMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('rejects invalid input (non-uuid)', async () => {
    expect(await startMilestoneAction({ engagementId: 'x', milestoneId: 'y' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when the engagement is missing', async () => {
    mockFindEngagement.mockResolvedValue(undefined);
    expect(await startMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'This engagement could not be found.',
    });
  });

  it('returns ONLY_EXPERT for a non-expert lens', async () => {
    mockResolveLens.mockReturnValue({
      lens: 'admin',
      archetype: 'observer',
      isClientOwner: false,
      isDeliveringExpert: false,
    });
    expect(await startMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'Only the delivering expert can update milestones.',
    });
  });

  it('returns ENGAGEMENT_LOCKED when the engagement is not active', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ status: 'completed' }));
    expect(await startMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'The delivery plan is locked while the project is in review.',
    });
  });

  it('is plan-locked during pending_acceptance review (BAL-334 D4 verify)', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ status: 'pending_acceptance' }));
    expect(await startMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'The delivery plan is locked while the project is in review.',
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('returns MILESTONE_GONE for a foreign milestoneId (IDOR)', async () => {
    expect(
      await startMilestoneAction({
        engagementId: ENGAGEMENT_ID,
        milestoneId: 'd0000000-0000-4000-8000-000000000999',
      })
    ).toEqual({
      success: false,
      error: 'This milestone is no longer part of this engagement — refresh and try again.',
    });
  });

  it('returns STALE_TRANSITION when the milestone is not pending', async () => {
    mockFindEngagement.mockResolvedValue(
      engagement({
        milestones: [
          {
            id: MILESTONE_ID,
            title: 'Discovery',
            status: 'in_progress',
            startedAt: null,
            completedAt: null,
            completionNote: null,
            updatedAt: new Date(),
          },
        ],
      })
    );
    expect(await startMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'This milestone changed since you loaded the page. Refresh and try again.',
    });
  });

  it('maps EngagementNotActiveError from the repo to ENGAGEMENT_LOCKED', async () => {
    mockStart.mockRejectedValue(new EngagementNotActiveError('x'));
    expect(await startMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'The delivery plan is locked while the project is in review.',
    });
  });

  it('maps InvalidMilestoneTransitionError from the repo to STALE_TRANSITION', async () => {
    mockStart.mockRejectedValue(new InvalidMilestoneTransitionError('x'));
    expect(await startMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'This milestone changed since you loaded the page. Refresh and try again.',
    });
  });

  it('maps an unexpected repo error to GENERIC_FAILURE and logs it', async () => {
    mockStart.mockRejectedValue(new Error('db down'));
    expect(await startMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith('Failed to start milestone', expect.any(Object));
  });

  it('starts, tracks days_since_kickoff, revalidates, and does NOT publish', async () => {
    const result = await startMilestoneAction(INPUT);
    expect(result).toEqual({ success: true, milestoneId: MILESTONE_ID, status: 'in_progress' });
    expect(mockStart).toHaveBeenCalledWith({ milestoneId: MILESTONE_ID, userId: 'user-1' });
    expect(mockTrack).toHaveBeenCalledWith('engagement_milestone_started', {
      engagement_id: ENGAGEMENT_ID,
      milestone_id: MILESTONE_ID,
      days_since_kickoff: 10,
      distinct_id: 'user-1',
    });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });
});
