import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CHARLES,
  DANA,
  FIXTURE_ENGAGEMENT_ID as ENGAGEMENT_ID,
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

const { mockFindEngagement, mockList, mockWithdraw, mockReturnToRequest } = vi.hoisted(() => ({
  mockFindEngagement: vi.fn(),
  mockList: vi.fn(),
  mockWithdraw: vi.fn(),
  mockReturnToRequest: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    findWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  engagementChangeOrdersRepository: {
    listForEngagement: (...a: unknown[]) => mockList(...a),
    withdraw: (...a: unknown[]) => mockWithdraw(...a),
    returnDraftToRequest: (...a: unknown[]) => mockReturnToRequest(...a),
  },
  companiesRepository: { findOwnerByCompanyId: vi.fn() },
  ChangeOrderAlreadyOpenError: class extends Error {},
  ChangeOrderCoherenceError: class extends Error {},
  ChangeOrderNotFoundError: class extends Error {},
  ChangeOrderPendingError: class extends Error {},
  InvalidChangeOrderTransitionError: class extends Error {},
  MilestonesIncompleteError: class extends Error {},
  InvalidEngagementTransitionError: class extends Error {},
  EngagementNotActiveError: class extends Error {},
  InvalidMilestoneTransitionError: class extends Error {},
  MilestoneChangePendingError: class extends Error {},
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ENGAGEMENT_SERVER_EVENTS: {},
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { discardChangeOrderDraftAction } from './discard-change-order-draft';

const INPUT = { engagementId: ENGAGEMENT_ID, orderId: ORDER_ID };
const call = { engagementId: ENGAGEMENT_ID, orderId: ORDER_ID, userId: CHARLES.id };

beforeEach(() => {
  vi.clearAllMocks();
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
});

describe('discardChangeOrderDraftAction', () => {
  it('returns a draft made from a client request to the request', async () => {
    mockList.mockResolvedValue([
      makeOrder({
        id: ORDER_ID,
        status: 'draft',
        requestedAt: new Date('2026-10-10T00:00:00Z'),
        requestedByUserId: DANA.id,
      }),
    ]);

    expect(await discardChangeOrderDraftAction(INPUT)).toEqual({ success: true });
    expect(mockReturnToRequest).toHaveBeenCalledWith(call);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('withdraws a draft the expert opened unprompted', async () => {
    mockList.mockResolvedValue([makeOrder({ id: ORDER_ID, status: 'draft' })]);

    expect(await discardChangeOrderDraftAction(INPUT)).toEqual({ success: true });
    expect(mockWithdraw).toHaveBeenCalledWith({ ...call, expectedFrom: 'draft' });
    expect(mockReturnToRequest).not.toHaveBeenCalled();
  });

  it('says the status changed when the order is gone, and writes nothing', async () => {
    mockList.mockResolvedValue([makeOrder({ id: 'someone-elses', status: 'draft' })]);

    expect(await discardChangeOrderDraftAction(INPUT)).toEqual({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(mockReturnToRequest).not.toHaveBeenCalled();
  });

  it('sends no analytics and no notification: the client never saw the draft', async () => {
    mockList.mockResolvedValue([makeOrder({ id: ORDER_ID, status: 'draft' })]);
    await discardChangeOrderDraftAction(INPUT);
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('refuses a caller without manage_engagement before reading any order', async () => {
    mockHasExpertCapability.mockResolvedValue(false);
    expect(await discardChangeOrderDraftAction(INPUT)).toEqual({
      success: false,
      error: 'Only the delivering expert can do that.',
    });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid engagement', async () => {
    expect(await discardChangeOrderDraftAction({ ...INPUT, engagementId: 'x' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
  });
});
