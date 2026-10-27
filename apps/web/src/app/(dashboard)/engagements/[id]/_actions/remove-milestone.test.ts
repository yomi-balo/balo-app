import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EngagementMilestone, ProjectEngagementWithMilestones } from '@balo/db';
import { engagementMilestoneFixture } from '@/test/fixtures/engagement-milestone';

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

const mockHasExpertCapability = vi.fn();
vi.mock('@/lib/authz/engagement', () => ({
  hasExpertDeliveryCapability: (...a: unknown[]) => mockHasExpertCapability(...a),
}));

const {
  mockFindEngagement,
  mockFindOwner,
  mockSoftDelete,
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
  MilestoneReorderMismatchError,
  MilestoneChangePendingError,
  MilestoneHasLoggedTimeError,
  ScopeChangeRequiresChangeOrderError,
} = vi.hoisted(() => {
  class EngagementNotActiveError extends Error {}
  class InvalidMilestoneTransitionError extends Error {}
  class MilestoneReorderMismatchError extends Error {}
  class MilestoneChangePendingError extends Error {}
  class MilestoneHasLoggedTimeError extends Error {}
  class ScopeChangeRequiresChangeOrderError extends Error {
    constructor(
      public readonly reason: string,
      public readonly pricingMethod: string
    ) {
      super(reason);
    }
  }
  return {
    mockFindEngagement: vi.fn(),
    mockFindOwner: vi.fn(),
    mockSoftDelete: vi.fn(),
    EngagementNotActiveError,
    InvalidMilestoneTransitionError,
    MilestoneReorderMismatchError,
    MilestoneChangePendingError,
    MilestoneHasLoggedTimeError,
    ScopeChangeRequiresChangeOrderError,
  };
});

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    findWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  companiesRepository: { findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
  engagementMilestonesRepository: { softDelete: (...a: unknown[]) => mockSoftDelete(...a) },
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
  MilestoneReorderMismatchError,
  MilestoneChangePendingError,
  MilestoneHasLoggedTimeError,
  ScopeChangeRequiresChangeOrderError,
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

function milestone(overrides: Partial<EngagementMilestone> = {}): EngagementMilestone {
  return engagementMilestoneFixture({
    id: MILESTONE_ID,
    title: 'Discovery',
    status: 'in_progress',
    sourceProposalMilestoneId: null,
    ...overrides,
  });
}

function engagement(overrides: Partial<ProjectEngagementWithMilestones> = {}) {
  return {
    id: ENGAGEMENT_ID,
    status: 'active',
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation' },
    expertProfile: {
      user: { id: 'user-1', firstName: 'Priya', lastName: 'Sharma' },
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
  mockHasExpertCapability.mockResolvedValue(true);
  mockRequireUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
  mockFindEngagement.mockResolvedValue(engagement());
  mockResolveLens.mockReturnValue(EXPERT_CTX);
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
  mockSoftDelete.mockResolvedValue({ id: MILESTONE_ID, title: 'Discovery', status: 'in_progress' });
});

describe('removeMilestoneAction', () => {
  it('refuses a milestone with logged time and tells the expert to complete it', async () => {
    mockSoftDelete.mockRejectedValue(new MilestoneHasLoggedTimeError('x'));
    expect(await removeMilestoneAction(INPUT)).toEqual({
      success: false,
      error: "Time has been logged on this milestone, so it can't be removed. Complete it instead.",
    });
  });

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

describe('removeMilestoneAction · scope-change refusal', () => {
  it('returns the typed scopeChange and client-naming copy when the repo needs a change order', async () => {
    mockSoftDelete.mockRejectedValue(
      new ScopeChangeRequiresChangeOrderError('remove_contracted', 'fixed')
    );
    const res = await removeMilestoneAction({
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
    });
    expect(res).toEqual({
      success: false,
      error: expect.stringContaining('Northwind Industrial'),
      scopeChange: { reason: 'remove_contracted', pricingMethod: 'fixed' },
    });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
