import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const MILESTONE_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_MILESTONE_ID = 'b0000000-0000-4000-8000-000000000999';
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
  mockSoftDelete,
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
    mockSoftDelete: vi.fn(),
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
  engagementMilestonesRepository: { softDelete: (...a: unknown[]) => mockSoftDelete(...a) },
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

vi.mock('@/lib/sanitize/project-html', () => ({
  sanitizeProjectHtml: (html: string) => `SANITIZED:${html}`,
}));

import { removeMilestoneAction } from './remove-milestone';
import { revalidatePath } from 'next/cache';

const EXPERT_CTX = {
  lens: 'expert',
  archetype: 'participant',
  isClientOwner: false,
  isDeliveringExpert: true,
};

function milestone(overrides: Record<string, unknown> = {}) {
  return {
    id: MILESTONE_ID,
    title: 'Discovery',
    status: 'in_progress',
    sourceProposalMilestoneId: null,
    ...overrides,
  };
}

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
    milestones: [milestone()],
    ...overrides,
  };
}

const INPUT = { engagementId: ENGAGEMENT_ID, milestoneId: MILESTONE_ID };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
  mockFindEngagement.mockResolvedValue(engagement());
  mockResolveLens.mockReturnValue(EXPERT_CTX);
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
  mockSoftDelete.mockResolvedValue({ id: MILESTONE_ID, title: 'Discovery', status: 'in_progress' });
});

describe('removeMilestoneAction', () => {
  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await removeMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('returns MILESTONE_GONE for a milestoneId not in the engagement (IDOR)', async () => {
    const res = await removeMilestoneAction({
      engagementId: ENGAGEMENT_ID,
      milestoneId: OTHER_MILESTONE_ID,
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toMatch(/no longer part of this engagement/);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('soft-deletes, tracks (was_completed false / no provenance), notifies, revalidates', async () => {
    const result = await removeMilestoneAction(INPUT);
    expect(result).toEqual({ success: true, milestoneId: MILESTONE_ID, status: 'in_progress' });

    expect(mockSoftDelete).toHaveBeenCalledWith({ milestoneId: MILESTONE_ID, userId: 'user-1' });
    expect(mockTrack).toHaveBeenCalledWith('engagement_milestone_removed', {
      engagement_id: ENGAGEMENT_ID,
      milestone_id: MILESTONE_ID,
      was_completed: false,
      had_source_provenance: false,
      distinct_id: 'user-1',
    });
    expect(mockPublish).toHaveBeenCalledWith('engagement.scope_changed', {
      correlationId: `${MILESTONE_ID}:removed`,
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      recipientId: 'owner-1',
      actorExpertLabel: 'Priya',
      projectTitle: 'CPQ implementation',
      changeKind: 'removed',
      changeSummary: "removed 'Discovery'",
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('removing a COMPLETED, provenance-backed milestone still succeeds (flags captured pre-delete)', async () => {
    mockFindEngagement.mockResolvedValue(
      engagement({
        milestones: [milestone({ status: 'completed', sourceProposalMilestoneId: 'prop-1' })],
      })
    );
    mockSoftDelete.mockResolvedValue({ id: MILESTONE_ID, title: 'Discovery', status: 'completed' });

    const result = await removeMilestoneAction(INPUT);
    expect(result).toEqual({ success: true, milestoneId: MILESTONE_ID, status: 'completed' });
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_milestone_removed',
      expect.objectContaining({ was_completed: true, had_source_provenance: true })
    );
  });

  it('omits recipientId when the owner lookup fails (retainer / no-owner)', async () => {
    mockFindOwner.mockRejectedValue(new Error('no owner'));
    await removeMilestoneAction(INPUT);
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.recipientId).toBeUndefined();
  });
});
