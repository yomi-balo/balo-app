import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const M1 = 'b0000000-0000-4000-8000-000000000002';
const M2 = 'b0000000-0000-4000-8000-000000000003';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireUser: () => mockRequireUser() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...a: unknown[]) => mockResolveLens(...a),
}));

const {
  mockFindEngagement,
  mockFindOwner,
  mockReorder,
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
  MilestoneReorderMismatchError,
} = vi.hoisted(() => {
  class EngagementNotActiveError extends Error {}
  class InvalidMilestoneTransitionError extends Error {}
  class MilestoneReorderMismatchError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockFindOwner: vi.fn(),
    mockReorder: vi.fn(),
    EngagementNotActiveError,
    InvalidMilestoneTransitionError,
    MilestoneReorderMismatchError,
  };
});

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  companiesRepository: { findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
  engagementMilestonesRepository: { reorder: (...a: unknown[]) => mockReorder(...a) },
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
  MilestoneReorderMismatchError,
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ENGAGEMENT_SERVER_EVENTS: {
    MILESTONE_STARTED: 'engagement_milestone_started',
    MILESTONE_COMPLETED: 'engagement_milestone_completed',
    MILESTONE_REVERTED: 'engagement_milestone_reverted',
    MILESTONE_ADDED: 'engagement_milestone_added',
    MILESTONE_EDITED: 'engagement_milestone_edited',
    MILESTONE_REMOVED: 'engagement_milestone_removed',
  },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { reorderMilestonesAction } from './reorder-milestones';
import { revalidatePath } from 'next/cache';

const EXPERT_CTX = {
  lens: 'expert',
  archetype: 'participant',
  isClientOwner: false,
  isDeliveringExpert: true,
};

function engagement(overrides: Record<string, unknown> = {}) {
  return {
    id: ENGAGEMENT_ID,
    status: 'active',
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation' },
    expertProfile: {
      user: { firstName: 'Priya', lastName: 'Sharma' },
      agency: null,
      headline: null,
      type: 'freelancer',
    },
    milestones: [
      { id: M1, title: 'Discovery', status: 'pending' },
      { id: M2, title: 'Build', status: 'pending' },
    ],
    ...overrides,
  };
}

const INPUT = { engagementId: ENGAGEMENT_ID, orderedMilestoneIds: [M2, M1] };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
  mockFindEngagement.mockResolvedValue(engagement());
  mockResolveLens.mockReturnValue(EXPERT_CTX);
  mockReorder.mockResolvedValue([]);
});

describe('reorderMilestonesAction', () => {
  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await reorderMilestonesAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockReorder).not.toHaveBeenCalled();
  });

  it('rejects an empty id list with INVALID_REQUEST', async () => {
    expect(
      await reorderMilestonesAction({ engagementId: ENGAGEMENT_ID, orderedMilestoneIds: [] })
    ).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockReorder).not.toHaveBeenCalled();
  });

  it('returns ONLY_EXPERT for a non-expert lens', async () => {
    mockResolveLens.mockReturnValue({ ...EXPERT_CTX, lens: 'admin' });
    expect(await reorderMilestonesAction(INPUT)).toEqual({
      success: false,
      error: 'Only the delivering expert can update milestones.',
    });
    expect(mockReorder).not.toHaveBeenCalled();
  });

  it('returns ENGAGEMENT_LOCKED when the engagement is not active (gate)', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ status: 'pending_acceptance' }));
    expect(await reorderMilestonesAction(INPUT)).toEqual({
      success: false,
      error: 'The delivery plan is locked while the project is in review.',
    });
    expect(mockReorder).not.toHaveBeenCalled();
  });

  it('reorders, revalidates, and fires NO analytics + NO notification', async () => {
    const result = await reorderMilestonesAction(INPUT);
    expect(result).toEqual({ success: true, milestoneId: '', status: 'pending' });
    expect(mockReorder).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      userId: 'user-1',
      orderedMilestoneIds: [M2, M1],
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('maps MilestoneReorderMismatchError → PLAN_CHANGED (no revalidate)', async () => {
    mockReorder.mockRejectedValue(new MilestoneReorderMismatchError('mismatch'));
    expect(await reorderMilestonesAction(INPUT)).toEqual({
      success: false,
      error: 'The delivery plan changed since you loaded the page. Refresh and try again.',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('maps a concurrent EngagementNotActiveError → ENGAGEMENT_LOCKED', async () => {
    mockReorder.mockRejectedValue(new EngagementNotActiveError('locked'));
    expect(await reorderMilestonesAction(INPUT)).toEqual({
      success: false,
      error: 'The delivery plan is locked while the project is in review.',
    });
  });

  it('maps any other repo error to GENERIC_FAILURE (boundary)', async () => {
    mockReorder.mockRejectedValue(new Error('db down'));
    expect(await reorderMilestonesAction(INPUT)).toEqual({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
  });
});
