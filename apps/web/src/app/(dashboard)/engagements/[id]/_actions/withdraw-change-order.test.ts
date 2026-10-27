import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CHARLES,
  FIXTURE_ENGAGEMENT_ID as ENGAGEMENT_ID,
  makeLine,
  makeOrder,
  makeProject,
} from '@/test/change-order-fixtures';

const ORDER_ID = 'b0000000-0000-4000-8000-0000000000a1';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: () => mockRequireUser() }));

const mockResolveLens = vi.fn();
vi.mock('@/lib/engagement/resolve-engagement-lens', () => ({
  resolveEngagementLens: (...a: unknown[]) => mockResolveLens(...a),
}));

vi.mock('@/lib/authz', () => ({ hasCapability: vi.fn(), CAPABILITIES: {} }));
const mockHasExpertCapability = vi.fn();
vi.mock('@/lib/authz/engagement', () => ({
  hasExpertDeliveryCapability: (...a: unknown[]) => mockHasExpertCapability(...a),
}));

const {
  mockFindEngagement,
  mockWithdraw,
  mockFindOwner,
  mockFindMembers,
  InvalidChangeOrderTransitionError,
} = vi.hoisted(() => {
  class InvalidChangeOrderTransitionError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockWithdraw: vi.fn(),
    mockFindOwner: vi.fn(),
    mockFindMembers: vi.fn(),
    InvalidChangeOrderTransitionError,
  };
});

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    findWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  engagementChangeOrdersRepository: { withdraw: (...a: unknown[]) => mockWithdraw(...a) },
  companiesRepository: {
    findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a),
    findWithMembers: (...a: unknown[]) => mockFindMembers(...a),
  },
  InvalidChangeOrderTransitionError,
  ChangeOrderAlreadyOpenError: class extends Error {},
  ChangeOrderCoherenceError: class extends Error {},
  ChangeOrderNotFoundError: class extends Error {},
  ChangeOrderPendingError: class extends Error {},
  MilestonesIncompleteError: class extends Error {},
  InvalidEngagementTransitionError: class extends Error {},
  EngagementNotActiveError: class extends Error {},
  InvalidMilestoneTransitionError: class extends Error {},
  MilestoneChangePendingError: class extends Error {},
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ENGAGEMENT_SERVER_EVENTS: { CHANGE_ORDER_WITHDRAWN: 'engagement_change_order_withdrawn' },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { withdrawChangeOrderAction } from './withdraw-change-order';

const INPUT = { engagementId: ENGAGEMENT_ID, orderId: ORDER_ID };

const withdrawn = makeOrder({
  id: ORDER_ID,
  status: 'withdrawn',
  priceDeltaCents: -50_000,
  sentAt: new Date('2026-10-12T00:00:00Z'),
  sentByUserId: CHARLES.id,
  lines: [makeLine({ op: 'remove', engagementMilestoneId: 'ms-1' })],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
  mockRequireUser.mockResolvedValue({
    id: CHARLES.id,
    firstName: 'Charles',
    lastName: 'Ng',
    platformRole: 'user',
    companyId: 'other-company',
    expertProfileId: 'expert-1',
  });
  mockFindEngagement.mockResolvedValue(makeProject());
  mockResolveLens.mockReturnValue({ lens: 'expert', archetype: 'participant' });
  mockHasExpertCapability.mockResolvedValue(true);
  mockWithdraw.mockResolvedValue(withdrawn);
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
  mockFindMembers.mockResolvedValue({ members: [{ userId: 'requester-1' }] });
});

describe('withdrawChangeOrderAction', () => {
  it('rejects a non-uuid order', async () => {
    expect(await withdrawChangeOrderAction({ ...INPUT, orderId: 'x' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
  });

  it('refuses a caller without manage_engagement', async () => {
    mockHasExpertCapability.mockResolvedValue(false);
    expect(await withdrawChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: 'Only the delivering expert can do that.',
    });
    expect(mockHasExpertCapability).toHaveBeenCalledWith(
      expect.anything(),
      'manage_engagement',
      'expert-1',
      expect.any(Object)
    );
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('withdraws only a SENT order, tracks it, and tells the client owner in-app', async () => {
    expect(await withdrawChangeOrderAction(INPUT)).toEqual({ success: true });

    expect(mockWithdraw).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      orderId: ORDER_ID,
      userId: CHARLES.id,
      expectedFrom: 'sent',
    });
    expect(mockTrack).toHaveBeenCalledWith('engagement_change_order_withdrawn', {
      engagement_id: ENGAGEMENT_ID,
      change_order_id: ORDER_ID,
      pricing_method: 'fixed',
      lines_added: 0,
      lines_edited: 0,
      lines_removed: 1,
      has_price_change: true,
      initiated_by: 'expert',
      distinct_id: CHARLES.id,
      days_to_decision: 2,
      acting_as: 'delivering_expert',
    });
    expect(mockPublish).toHaveBeenCalledWith('change_order.withdrawn', {
      correlationId: `${ORDER_ID}:withdrawn`,
      engagementId: ENGAGEMENT_ID,
      changeOrderId: ORDER_ID,
      projectTitle: 'CPQ rollout',
      recipientId: 'owner-1',
      actorExpertLabel: 'Charles',
    });
  });

  it('names an agency admin as the actor and tracks acting_as agency_admin', async () => {
    mockRequireUser.mockResolvedValue({
      id: 'admin-1',
      firstName: 'Dana',
      lastName: 'Lee',
      platformRole: 'user',
      companyId: 'other-company',
      expertProfileId: 'expert-2',
    });
    mockFindEngagement.mockResolvedValue(
      makeProject({
        expertProfile: {
          id: 'expert-1',
          agencyId: 'agency-1',
          type: 'agency',
          headline: null,
          timezone: 'UTC',
          user: { id: CHARLES.id, firstName: 'Charles', lastName: 'Ng', avatarUrl: null },
          agency: { name: 'CloudPeak' },
        },
      } as never)
    );
    await withdrawChangeOrderAction(INPUT);
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_change_order_withdrawn',
      expect.objectContaining({ acting_as: 'agency_admin' })
    );
    expect(mockPublish.mock.calls[0]?.[1]).toMatchObject({ actorExpertLabel: 'Dana @ CloudPeak' });
  });

  it('tells the requester too when the withdrawn order came from a request', async () => {
    mockWithdraw.mockResolvedValue({ ...withdrawn, requestedByUserId: 'requester-1' });
    await withdrawChangeOrderAction(INPUT);
    expect(mockPublish.mock.calls[0]?.[1]).toMatchObject({ requestedByUserId: 'requester-1' });
  });

  it('leaves the requester out when they have left the company or are the owner', async () => {
    mockWithdraw.mockResolvedValue({ ...withdrawn, requestedByUserId: 'requester-1' });
    mockFindMembers.mockResolvedValue({ members: [] });
    await withdrawChangeOrderAction(INPUT);
    expect(mockPublish.mock.calls[0]?.[1]).not.toHaveProperty('requestedByUserId');

    mockPublish.mockClear();
    mockFindMembers.mockResolvedValue({ members: [{ userId: 'requester-1' }] });
    mockFindOwner.mockResolvedValue({ id: 'requester-1' });
    await withdrawChangeOrderAction(INPUT);
    expect(mockPublish.mock.calls[0]?.[1]).not.toHaveProperty('requestedByUserId');
  });

  it('maps an order that was decided meanwhile to STATUS_CHANGED', async () => {
    mockWithdraw.mockRejectedValue(new InvalidChangeOrderTransitionError('x'));
    expect(await withdrawChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
