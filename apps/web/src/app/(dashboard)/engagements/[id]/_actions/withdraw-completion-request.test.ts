import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectEngagementWithMilestones } from '@balo/db';

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

const mockHasExpertCapability = vi.fn();
vi.mock('@/lib/authz/engagement', () => ({
  hasExpertDeliveryCapability: (...a: unknown[]) => mockHasExpertCapability(...a),
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
  projectEngagementsRepository: {
    findWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
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

function engagement(overrides: Partial<ProjectEngagementWithMilestones> = {}) {
  return {
    id: ENGAGEMENT_ID,
    expertProfileId: 'expert-1',
    status: 'pending_acceptance',
    completionRequestedAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3h ago
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation' },
    expertProfile: {
      id: 'expert-1',
      user: { id: 'user-1', firstName: 'Priya', lastName: 'Sharma' },
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
  mockHasExpertCapability.mockResolvedValue(true);
  mockRequireUser.mockResolvedValue({
    id: 'user-1',
    platformRole: 'user',
    expertProfileId: 'expert-1',
  });
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
    mockHasExpertCapability.mockResolvedValue(false);
    mockResolveLens.mockReturnValue({ lens: 'admin', archetype: 'observer' });
    expect(await withdrawCompletionRequestAction(INPUT)).toEqual({
      success: false,
      error: 'Only the delivering expert can do that.',
    });
  });

  it('names an agency admin who withdraws the request', async () => {
    mockRequireUser.mockResolvedValue({
      id: 'admin-1',
      firstName: 'Dana',
      lastName: 'Lee',
      platformRole: 'user',
      expertProfileId: 'expert-2',
    });
    mockFindEngagement.mockResolvedValue(
      engagement({
        expertProfile: {
          id: 'expert-1',
          user: { id: 'user-1', firstName: 'Priya', lastName: 'Sharma' },
          agency: { name: 'CloudPeak' },
          headline: null,
          type: 'agency',
        },
      } as never)
    );
    expect(await withdrawCompletionRequestAction(INPUT)).toEqual({ success: true });
    expect(mockHasExpertCapability).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-1' }),
      'manage_engagement',
      'expert-1',
      { contextType: 'project', contextId: ENGAGEMENT_ID }
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.completion_withdrawn',
      expect.objectContaining({ actorExpertLabel: 'Dana @ CloudPeak' })
    );
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_completion_withdrawn',
      expect.objectContaining({ acting_as: 'agency_admin', distinct_id: 'admin-1' })
    );
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
        acting_as: 'delivering_expert',
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
