import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const REQUESTED_AT = new Date('2026-07-04T00:00:00.000Z');

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
  mockRequestCompletion,
  mockCountByEntityAndAction,
  mockProposalFindById,
  MilestonesIncompleteError,
  InvalidEngagementTransitionError,
} = vi.hoisted(() => {
  class MilestonesIncompleteError extends Error {}
  class InvalidEngagementTransitionError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockFindOwner: vi.fn(),
    mockRequestCompletion: vi.fn(),
    mockCountByEntityAndAction: vi.fn(),
    mockProposalFindById: vi.fn(),
    MilestonesIncompleteError,
    InvalidEngagementTransitionError,
  };
});

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
    requestCompletion: (...a: unknown[]) => mockRequestCompletion(...a),
  },
  companiesRepository: { findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
  proposalsRepository: { findById: (...a: unknown[]) => mockProposalFindById(...a) },
  auditEventsRepository: {
    countByEntityAndAction: (...a: unknown[]) => mockCountByEntityAndAction(...a),
  },
  AUTO_ACCEPT_DAYS: 7,
  MilestonesIncompleteError,
  InvalidEngagementTransitionError,
  // Consumed by milestone-action-shared at module load.
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

import { requestCompletionAction } from './request-completion';
import { revalidatePath } from 'next/cache';

const INPUT = { engagementId: ENGAGEMENT_ID };

function engagement(overrides: Record<string, unknown> = {}) {
  return {
    id: ENGAGEMENT_ID,
    status: 'active',
    sourceProposalId: 'p0000000-0000-4000-8000-000000000009',
    activatedAt: new Date('2026-06-24T00:00:00Z'),
    createdAt: new Date('2026-06-01T00:00:00Z'),
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation' },
    expertProfile: {
      id: 'expert-1',
      user: { firstName: 'Priya', lastName: 'Sharma' },
      agency: null,
      headline: null,
      type: 'freelancer',
    },
    milestones: [{ status: 'completed' }, { status: 'completed' }],
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
  mockRequestCompletion.mockResolvedValue({ completionRequestedAt: REQUESTED_AT });
  mockCountByEntityAndAction.mockResolvedValue(1);
  mockProposalFindById.mockResolvedValue({ timeframeWeeks: 10 });
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
});

describe('requestCompletionAction', () => {
  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await requestCompletionAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockRequestCompletion).not.toHaveBeenCalled();
  });

  it('rejects invalid input (non-uuid)', async () => {
    expect(await requestCompletionAction({ engagementId: 'x' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
  });

  it('returns NOT_FOUND when the engagement is missing', async () => {
    mockFindEngagement.mockResolvedValue(undefined);
    expect(await requestCompletionAction(INPUT)).toEqual({
      success: false,
      error: 'This engagement could not be found.',
    });
  });

  it('returns NOT_FOUND for a stranger (null lens — no existence leak)', async () => {
    mockResolveLens.mockReturnValue(null);
    expect(await requestCompletionAction(INPUT)).toEqual({
      success: false,
      error: 'This engagement could not be found.',
    });
  });

  it('returns ONLY_EXPERT for a non-expert lens', async () => {
    mockResolveLens.mockReturnValue({ lens: 'admin', archetype: 'observer' });
    expect(await requestCompletionAction(INPUT)).toEqual({
      success: false,
      error: 'Only the delivering expert can do that.',
    });
  });

  it('returns NOT_ACTIVE when the engagement is not active', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ status: 'pending_acceptance' }));
    expect(await requestCompletionAction(INPUT)).toEqual({
      success: false,
      error: "This project isn't active.",
    });
  });

  it('maps MilestonesIncompleteError from the repo to MILESTONES_INCOMPLETE', async () => {
    mockRequestCompletion.mockRejectedValue(new MilestonesIncompleteError('x'));
    expect(await requestCompletionAction(INPUT)).toEqual({
      success: false,
      error:
        'Not every milestone is complete yet — finish them before sending the project for review.',
    });
  });

  it('maps InvalidEngagementTransitionError from the repo to STATUS_CHANGED', async () => {
    mockRequestCompletion.mockRejectedValue(new InvalidEngagementTransitionError('x'));
    expect(await requestCompletionAction(INPUT)).toEqual({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
  });

  it('requests completion, tracks the metrics, publishes, and revalidates', async () => {
    const result = await requestCompletionAction(INPUT);
    expect(result).toEqual({ success: true });
    expect(mockRequestCompletion).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      userId: 'user-1',
    });

    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_completion_requested',
      expect.objectContaining({
        engagement_id: ENGAGEMENT_ID,
        proposed_timeframe_weeks: 10,
        milestones_total: 2,
        review_cycle: 1,
        distinct_id: 'user-1',
        days_since_kickoff: expect.any(Number),
      })
    );

    expect(mockPublish).toHaveBeenCalledWith('engagement.completion_requested', {
      correlationId: `${ENGAGEMENT_ID}:completion_requested:${REQUESTED_AT.getTime()}`,
      engagementId: ENGAGEMENT_ID,
      recipientId: 'owner-1',
      clientCompanyName: 'Northwind Industrial',
      expertPartyLabel: 'Priya Sharma',
      actorExpertLabel: 'Priya',
      projectTitle: 'CPQ implementation',
      milestonesTotal: 2,
      requestedDate: '4 Jul',
      autoDate: '11 Jul',
      reviewDays: 7,
    });

    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('degrades review_cycle to 1 when the audit count read throws', async () => {
    mockCountByEntityAndAction.mockRejectedValue(new Error('db hiccup'));
    const result = await requestCompletionAction(INPUT);
    expect(result).toEqual({ success: true });
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_completion_requested',
      expect.objectContaining({ review_cycle: 1 })
    );
  });

  it('reads null proposed_timeframe_weeks for a retainer (no source proposal)', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ sourceProposalId: null }));
    await requestCompletionAction(INPUT);
    expect(mockProposalFindById).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_completion_requested',
      expect.objectContaining({ proposed_timeframe_weeks: null })
    );
  });
});
