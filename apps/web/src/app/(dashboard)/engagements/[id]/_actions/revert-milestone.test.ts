import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const MILESTONE_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-07-01T00:00:00Z');
const COMPLETED_AT_BEFORE = new Date('2026-06-30T00:00:00Z'); // 24h before NOW
const UPDATED_AT = new Date('2026-07-01T00:00:00Z');

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
  mockRevert,
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
} = vi.hoisted(() => {
  class EngagementNotActiveError extends Error {}
  class InvalidMilestoneTransitionError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockFindOwner: vi.fn(),
    mockRevert: vi.fn(),
    EngagementNotActiveError,
    InvalidMilestoneTransitionError,
  };
});

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  companiesRepository: { findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
  engagementMilestonesRepository: { revert: (...a: unknown[]) => mockRevert(...a) },
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

import { revertMilestoneAction } from './revert-milestone';
import { revalidatePath } from 'next/cache';

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
        status: 'completed',
        startedAt: new Date('2026-06-20T00:00:00Z'),
        completedAt: COMPLETED_AT_BEFORE,
        completionNote: 'Done.',
        updatedAt: COMPLETED_AT_BEFORE,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockRequireUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
  mockFindEngagement.mockResolvedValue(engagement());
  mockResolveLens.mockReturnValue({
    lens: 'expert',
    archetype: 'participant',
    isClientOwner: false,
    isDeliveringExpert: true,
  });
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
  mockRevert.mockResolvedValue({
    id: MILESTONE_ID,
    title: 'Discovery',
    status: 'in_progress',
    completedAt: null,
    updatedAt: UPDATED_AT,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('revertMilestoneAction', () => {
  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await revertMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockRevert).not.toHaveBeenCalled();
  });

  it('returns STALE_TRANSITION when the milestone is not completed', async () => {
    mockFindEngagement.mockResolvedValue(
      engagement({
        milestones: [
          {
            id: MILESTONE_ID,
            title: 'Discovery',
            status: 'in_progress',
            startedAt: new Date(),
            completedAt: null,
            completionNote: null,
            updatedAt: new Date(),
          },
        ],
      })
    );
    expect(await revertMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'This milestone changed since you loaded the page. Refresh and try again.',
    });
  });

  it('reverts, deriving hours_since_completed from the PRE-loaded completedAt, and publishes', async () => {
    const result = await revertMilestoneAction(INPUT);
    expect(result).toEqual({ success: true, milestoneId: MILESTONE_ID, status: 'in_progress' });

    expect(mockRevert).toHaveBeenCalledWith({ milestoneId: MILESTONE_ID, userId: 'user-1' });
    expect(mockTrack).toHaveBeenCalledWith('engagement_milestone_reverted', {
      engagement_id: ENGAGEMENT_ID,
      milestone_id: MILESTONE_ID,
      hours_since_completed: 24,
      distinct_id: 'user-1',
    });
    expect(mockPublish).toHaveBeenCalledWith('engagement.milestone_reverted', {
      correlationId: `${MILESTONE_ID}:reverted:${UPDATED_AT.getTime()}`,
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      recipientId: 'owner-1',
      actorExpertLabel: 'Priya',
      milestoneTitle: 'Discovery',
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('uses hours_since_completed 0 when the pre-loaded completedAt is null', async () => {
    mockFindEngagement.mockResolvedValue(
      engagement({
        milestones: [
          {
            id: MILESTONE_ID,
            title: 'Discovery',
            status: 'completed',
            startedAt: new Date('2026-06-20T00:00:00Z'),
            completedAt: null,
            completionNote: null,
            updatedAt: COMPLETED_AT_BEFORE,
          },
        ],
      })
    );
    await revertMilestoneAction(INPUT);
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_milestone_reverted',
      expect.objectContaining({ hours_since_completed: 0 })
    );
  });

  it('maps an unexpected repo error to GENERIC_FAILURE', async () => {
    mockRevert.mockRejectedValue(new Error('db down'));
    expect(await revertMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
  });
});
