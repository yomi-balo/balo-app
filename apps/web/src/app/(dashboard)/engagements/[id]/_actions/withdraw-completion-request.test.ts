import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: () => mockRequireUser() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...a: unknown[]) => mockResolveLens(...a),
}));

const { mockFindEngagement, mockFindOwner, mockWithdraw, InvalidEngagementTransitionError } =
  vi.hoisted(() => {
    class InvalidEngagementTransitionError extends Error {}
    return {
      mockFindEngagement: vi.fn(),
      mockFindOwner: vi.fn(),
      mockWithdraw: vi.fn(),
      InvalidEngagementTransitionError,
    };
  });

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
    withdrawCompletionRequest: (...a: unknown[]) => mockWithdraw(...a),
  },
  companiesRepository: { findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
  MilestonesIncompleteError: class extends Error {},
  InvalidEngagementTransitionError,
  EngagementNotActiveError: class extends Error {},
  InvalidMilestoneTransitionError: class extends Error {},
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ENGAGEMENT_SERVER_EVENTS: {
    COMPLETION_REQUESTED: 'engagement_completion_requested',
    COMPLETION_WITHDRAWN: 'engagement_completion_withdrawn',
    CANCELLED: 'engagement_cancelled',
  },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { withdrawCompletionRequestAction } from './withdraw-completion-request';
import { revalidatePath } from 'next/cache';

const INPUT = { engagementId: ENGAGEMENT_ID };

function engagement(overrides: Record<string, unknown> = {}) {
  return {
    id: ENGAGEMENT_ID,
    status: 'pending_acceptance',
    completionRequestedAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3h ago
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation' },
    expertProfile: {
      id: 'expert-1',
      user: { firstName: 'Priya', lastName: 'Sharma' },
      agency: null,
      headline: null,
      type: 'freelancer',
    },
    milestones: [],
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
  mockWithdraw.mockResolvedValue({ status: 'active' });
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
});

describe('withdrawCompletionRequestAction', () => {
  it('returns NOT_UNDER_REVIEW when the engagement is not pending_acceptance', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ status: 'active' }));
    expect(await withdrawCompletionRequestAction(INPUT)).toEqual({
      success: false,
      error: "This project isn't under review.",
    });
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('returns ONLY_EXPERT for a non-expert lens', async () => {
    mockResolveLens.mockReturnValue({ lens: 'admin', archetype: 'observer' });
    expect(await withdrawCompletionRequestAction(INPUT)).toEqual({
      success: false,
      error: 'Only the delivering expert can do that.',
    });
  });

  it('withdraws, tracks hours_in_review from the pre-withdraw stamp, publishes, revalidates', async () => {
    const result = await withdrawCompletionRequestAction(INPUT);
    expect(result).toEqual({ success: true });
    expect(mockWithdraw).toHaveBeenCalledWith({ engagementId: ENGAGEMENT_ID, userId: 'user-1' });

    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_completion_withdrawn',
      expect.objectContaining({
        engagement_id: ENGAGEMENT_ID,
        hours_in_review: 3,
        distinct_id: 'user-1',
      })
    );

    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.completion_withdrawn',
      expect.objectContaining({
        correlationId: expect.stringMatching(
          new RegExp(`^${ENGAGEMENT_ID}:completion_withdrawn:\\d+$`)
        ),
        engagementId: ENGAGEMENT_ID,
        recipientId: 'owner-1',
        actorExpertLabel: 'Priya',
        projectTitle: 'CPQ implementation',
      })
    );

    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('tracks hours_in_review 0 when completionRequestedAt is absent', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ completionRequestedAt: null }));
    await withdrawCompletionRequestAction(INPUT);
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_completion_withdrawn',
      expect.objectContaining({ hours_in_review: 0 })
    );
  });
});
