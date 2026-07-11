import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';
const MILESTONE_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const COMPLETED_AT = new Date('2026-06-30T00:00:00Z');

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
  mockComplete,
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
} = vi.hoisted(() => {
  class EngagementNotActiveError extends Error {}
  class InvalidMilestoneTransitionError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockFindOwner: vi.fn(),
    mockComplete: vi.fn(),
    EngagementNotActiveError,
    InvalidMilestoneTransitionError,
  };
});

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  companiesRepository: { findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
  engagementMilestonesRepository: { complete: (...a: unknown[]) => mockComplete(...a) },
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

import { completeMilestoneAction } from './complete-milestone';
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
        status: 'in_progress',
        startedAt: new Date('2026-06-20T00:00:00Z'),
        completedAt: null,
        completionNote: null,
        updatedAt: new Date('2026-06-20T00:00:00Z'),
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
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
  mockComplete.mockResolvedValue({
    id: MILESTONE_ID,
    title: 'Discovery',
    status: 'completed',
    startedAt: new Date('2026-06-20T00:00:00Z'),
    completedAt: COMPLETED_AT,
  });
});

describe('completeMilestoneAction', () => {
  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await completeMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('rejects a completionNote over 4000 chars', async () => {
    expect(await completeMilestoneAction({ ...INPUT, completionNote: 'a'.repeat(4001) })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('returns STALE_TRANSITION when the milestone is not in progress', async () => {
    mockFindEngagement.mockResolvedValue(
      engagement({
        milestones: [
          {
            id: MILESTONE_ID,
            title: 'Discovery',
            status: 'pending',
            startedAt: null,
            completedAt: null,
            completionNote: null,
            updatedAt: new Date(),
          },
        ],
      })
    );
    expect(await completeMilestoneAction(INPUT)).toEqual({
      success: false,
      error: 'This milestone changed since you loaded the page. Refresh and try again.',
    });
  });

  it('completes WITH a note: tracks cycle time + has_completion_note, publishes the full payload', async () => {
    const result = await completeMilestoneAction({ ...INPUT, completionNote: 'Shipped the deck.' });
    expect(result).toEqual({ success: true, milestoneId: MILESTONE_ID, status: 'completed' });

    expect(mockComplete).toHaveBeenCalledWith({
      milestoneId: MILESTONE_ID,
      userId: 'user-1',
      completionNote: 'Shipped the deck.',
    });
    expect(mockTrack).toHaveBeenCalledWith('engagement_milestone_completed', {
      engagement_id: ENGAGEMENT_ID,
      milestone_id: MILESTONE_ID,
      cycle_time_days: 10,
      has_completion_note: true,
      distinct_id: 'user-1',
    });
    expect(mockPublish).toHaveBeenCalledWith('engagement.milestone_completed', {
      correlationId: `${MILESTONE_ID}:${COMPLETED_AT.getTime()}`,
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      recipientId: 'owner-1',
      expertPartyLabel: 'Priya Sharma',
      actorExpertLabel: 'Priya',
      projectTitle: 'CPQ implementation',
      milestoneTitle: 'Discovery',
      completedOn: '30 Jun 2026',
      completionNote: 'Shipped the deck.',
      completedCount: 1,
      totalCount: 1,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('completes WITHOUT a note (empty → omitted): has_completion_note false, note undefined', async () => {
    await completeMilestoneAction({ ...INPUT, completionNote: '   ' });
    expect(mockComplete).toHaveBeenCalledWith({
      milestoneId: MILESTONE_ID,
      userId: 'user-1',
      completionNote: undefined,
    });
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_milestone_completed',
      expect.objectContaining({ has_completion_note: false })
    );
    const [, payload] = mockPublish.mock.calls[0]!;
    expect(payload.completionNote).toBeUndefined();
  });

  it('omits recipientId when the owner lookup fails (retainer / no-owner)', async () => {
    mockFindOwner.mockRejectedValue(new Error('no owner'));
    await completeMilestoneAction(INPUT);
    const [, payload] = mockPublish.mock.calls[0]!;
    expect(payload.recipientId).toBeUndefined();
  });

  it('falls back to a retainer projectTitle when there is no source request', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ projectRequest: null }));
    await completeMilestoneAction(INPUT);
    const [, payload] = mockPublish.mock.calls[0]!;
    expect(payload.projectTitle).toBe('Delivery with Priya');
  });

  it('guards a null startedAt → cycle_time_days 0 (no throw)', async () => {
    mockComplete.mockResolvedValue({
      id: MILESTONE_ID,
      title: 'Discovery',
      status: 'completed',
      startedAt: null,
      completedAt: COMPLETED_AT,
    });
    const result = await completeMilestoneAction(INPUT);
    expect(result).toEqual({ success: true, milestoneId: MILESTONE_ID, status: 'completed' });
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_milestone_completed',
      expect.objectContaining({ cycle_time_days: 0 })
    );
  });

  it('guards a null completedAt → cycle_time_days 0, correlationId/completedOn fall back (no throw)', async () => {
    mockComplete.mockResolvedValue({
      id: MILESTONE_ID,
      title: 'Discovery',
      status: 'completed',
      startedAt: new Date('2026-06-20T00:00:00Z'),
      completedAt: null,
    });
    const result = await completeMilestoneAction(INPUT);
    expect(result).toEqual({ success: true, milestoneId: MILESTONE_ID, status: 'completed' });
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_milestone_completed',
      expect.objectContaining({ cycle_time_days: 0 })
    );
    // The `?? Date.now()` / `?? new Date()` fallbacks still produce a well-formed payload.
    const [, payload] = mockPublish.mock.calls[0]!;
    expect(typeof payload.completedOn).toBe('string');
    expect(payload.correlationId).toContain(`${MILESTONE_ID}:`);
  });
});
