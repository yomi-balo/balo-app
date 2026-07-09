import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireUser: () => mockRequireUser() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...a: unknown[]) => mockResolveLens(...a),
}));

const { mockFindEngagement, mockFindOwner, mockCancel, InvalidEngagementTransitionError } =
  vi.hoisted(() => {
    class InvalidEngagementTransitionError extends Error {}
    return {
      mockFindEngagement: vi.fn(),
      mockFindOwner: vi.fn(),
      mockCancel: vi.fn(),
      InvalidEngagementTransitionError,
    };
  });

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
    cancelEngagement: (...a: unknown[]) => mockCancel(...a),
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

import { cancelEngagementAction } from './cancel-engagement';
import { revalidatePath } from 'next/cache';

const INPUT = { engagementId: ENGAGEMENT_ID, reason: 'Client changed direction.' };

function engagement(overrides: Record<string, unknown> = {}) {
  return {
    id: ENGAGEMENT_ID,
    status: 'active',
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
    milestones: [{ status: 'completed' }, { status: 'in_progress' }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: 'admin-1', platformRole: 'admin' });
  mockFindEngagement.mockResolvedValue(engagement());
  mockResolveLens.mockReturnValue({ lens: 'admin', archetype: 'observer' });
  mockCancel.mockResolvedValue({ status: 'cancelled' });
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
});

describe('cancelEngagementAction', () => {
  it('rejects an empty reason as INVALID_REQUEST', async () => {
    expect(await cancelEngagementAction({ engagementId: ENGAGEMENT_ID, reason: '   ' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('returns ONLY_ADMIN for a non-admin lens', async () => {
    mockResolveLens.mockReturnValue({ lens: 'expert', archetype: 'participant' });
    expect(await cancelEngagementAction(INPUT)).toEqual({
      success: false,
      error: 'Only Balo can cancel an engagement.',
    });
  });

  it('returns ENGAGEMENT_CLOSED for a terminal engagement', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ status: 'completed' }));
    expect(await cancelEngagementAction(INPUT)).toEqual({
      success: false,
      error: 'This engagement is already closed.',
    });
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('cancels from active: tracks status + milestone counts, publishes both parties, revalidates', async () => {
    const result = await cancelEngagementAction(INPUT);
    expect(result).toEqual({ success: true });
    expect(mockCancel).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      userId: 'admin-1',
      reason: 'Client changed direction.',
    });

    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_cancelled',
      expect.objectContaining({
        engagement_id: ENGAGEMENT_ID,
        status_at_cancel: 'active',
        milestones_completed: 1,
        milestones_total: 2,
        distinct_id: 'admin-1',
        days_since_kickoff: expect.any(Number),
      })
    );

    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.cancelled',
      expect.objectContaining({
        correlationId: `${ENGAGEMENT_ID}:cancelled`,
        engagementId: ENGAGEMENT_ID,
        recipientId: 'owner-1',
        expertProfileId: 'expert-1',
        projectTitle: 'CPQ implementation',
        reason: 'Client changed direction.',
      })
    );

    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('reports status_at_cancel = pending_acceptance when cancelling from review', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ status: 'pending_acceptance' }));
    await cancelEngagementAction(INPUT);
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_cancelled',
      expect.objectContaining({ status_at_cancel: 'pending_acceptance' })
    );
  });

  it('maps InvalidEngagementTransitionError from the repo to STATUS_CHANGED', async () => {
    mockCancel.mockRejectedValue(new InvalidEngagementTransitionError('x'));
    expect(await cancelEngagementAction(INPUT)).toEqual({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
  });
});
