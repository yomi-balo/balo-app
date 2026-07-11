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

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { PARTICIPATE: 'participate' },
}));

const { mockFindEngagement, mockAccept, mockCountAudit, InvalidEngagementTransitionError } =
  vi.hoisted(() => {
    class InvalidEngagementTransitionError extends Error {}
    return {
      mockFindEngagement: vi.fn(),
      mockAccept: vi.fn(),
      mockCountAudit: vi.fn(),
      InvalidEngagementTransitionError,
    };
  });

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
    acceptCompletion: (...a: unknown[]) => mockAccept(...a),
  },
  auditEventsRepository: { countByEntityAndAction: (...a: unknown[]) => mockCountAudit(...a) },
  companiesRepository: { findOwnerByCompanyId: vi.fn() },
  AUTO_ACCEPT_DAYS: 7,
  MilestonesIncompleteError: class extends Error {},
  InvalidEngagementTransitionError,
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ENGAGEMENT_SERVER_EVENTS: {
    ACCEPTED: 'engagement_accepted',
    CHANGES_REQUESTED: 'engagement_changes_requested',
  },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { acceptProjectAction } from './accept-project';
import { revalidatePath } from 'next/cache';

const INPUT = { engagementId: ENGAGEMENT_ID };

function engagement(overrides: Record<string, unknown> = {}) {
  return {
    id: ENGAGEMENT_ID,
    status: 'pending_acceptance',
    companyId: COMPANY_ID,
    expertProfileId: 'expert-1',
    completionRequestedAt: new Date('2026-07-04T00:00:00Z'),
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
  mockRequireUser.mockResolvedValue({
    id: 'client-1',
    firstName: 'Dana',
    lastName: 'Lee',
    platformRole: 'user',
    companyId: COMPANY_ID,
  });
  mockFindEngagement.mockResolvedValue(engagement());
  mockResolveLens.mockReturnValue({ lens: 'client', archetype: 'participant' });
  mockHasCapability.mockResolvedValue(true);
  mockAccept.mockResolvedValue({
    status: 'completed',
    acceptedAt: new Date('2026-07-11T00:00:00Z'),
  });
  mockCountAudit.mockResolvedValue(1);
});

describe('acceptProjectAction', () => {
  it('rejects a malformed engagementId as INVALID_REQUEST', async () => {
    expect(await acceptProjectAction({ engagementId: 'not-a-uuid' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('returns ONLY_CLIENT for a non-client lens', async () => {
    mockResolveLens.mockReturnValue({ lens: 'expert', archetype: 'participant' });
    expect(await acceptProjectAction(INPUT)).toEqual({
      success: false,
      error: 'Only the client can do that.',
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('returns NOT_UNDER_REVIEW when the engagement is not pending_acceptance', async () => {
    mockFindEngagement.mockResolvedValue(engagement({ status: 'active' }));
    expect(await acceptProjectAction(INPUT)).toEqual({
      success: false,
      error: "This project isn't under review.",
    });
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('fails closed (ONLY_CLIENT) when the live membership capability is missing', async () => {
    mockHasCapability.mockResolvedValue(false);
    expect(await acceptProjectAction(INPUT)).toEqual({
      success: false,
      error: 'Only the client can do that.',
    });
    expect(mockHasCapability).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'client-1' }),
      'participate',
      { companyId: COMPANY_ID }
    );
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('accepts as the client: tracks method=client, publishes expert+admin, revalidates', async () => {
    const result = await acceptProjectAction(INPUT);
    expect(result).toEqual({ success: true });
    expect(mockAccept).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      method: 'client',
      userId: 'client-1',
    });

    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_accepted',
      expect.objectContaining({
        engagement_id: ENGAGEMENT_ID,
        acceptance_method: 'client',
        review_cycle: 1,
        distinct_id: 'client-1',
        days_in_review: expect.any(Number),
      })
    );

    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.accepted',
      expect.objectContaining({
        correlationId: `${ENGAGEMENT_ID}:accepted`,
        engagementId: ENGAGEMENT_ID,
        expertProfileId: 'expert-1',
        actorClientLabel: 'Dana @ Northwind Industrial',
        projectTitle: 'CPQ implementation',
        acceptedOn: '11 Jul 2026',
        milestonesTotal: 2,
      })
    );

    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('maps InvalidEngagementTransitionError from the repo to STATUS_CHANGED', async () => {
    mockAccept.mockRejectedValue(new InvalidEngagementTransitionError('x'));
    expect(await acceptProjectAction(INPUT)).toEqual({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
  });
});
