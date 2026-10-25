import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CHARLES,
  FIXTURE_COMPANY_ID as COMPANY_ID,
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

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { PARTICIPATE: 'participate', APPROVE_OWN_PROPOSALS: 'approve_own_proposals' },
}));
vi.mock('@/lib/authz/engagement', () => ({ hasExpertDeliveryCapability: vi.fn() }));

const { mockFindEngagement, mockDecline, InvalidChangeOrderTransitionError } = vi.hoisted(() => {
  class InvalidChangeOrderTransitionError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockDecline: vi.fn(),
    InvalidChangeOrderTransitionError,
  };
});

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    findWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  engagementChangeOrdersRepository: { decline: (...a: unknown[]) => mockDecline(...a) },
  companiesRepository: { findOwnerByCompanyId: vi.fn() },
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
  ENGAGEMENT_SERVER_EVENTS: { CHANGE_ORDER_DECLINED: 'engagement_change_order_declined' },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { declineChangeOrderAction } from './decline-change-order';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const REASON = 'Too expensive for this quarter.';
const INPUT = { engagementId: ENGAGEMENT_ID, orderId: ORDER_ID, reason: REASON };

const declined = makeOrder({
  id: ORDER_ID,
  status: 'declined',
  priceDeltaCents: 100_000,
  requestedAt: new Date('2026-10-10T00:00:00Z'),
  requestedByUserId: 'user-1',
  sentAt: new Date('2026-10-12T00:00:00Z'),
  sentByUserId: CHARLES.id,
  declineReason: REASON,
  lines: [makeLine({ op: 'add' }), makeLine({ id: 'l2', op: 'edit' })],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
  mockRequireUser.mockResolvedValue({
    id: 'user-1',
    firstName: 'Dana',
    lastName: 'Lee',
    platformRole: 'user',
    companyId: COMPANY_ID,
  });
  mockFindEngagement.mockResolvedValue(makeProject());
  mockResolveLens.mockReturnValue({ lens: 'client', archetype: 'participant' });
  mockHasCapability.mockResolvedValue(true);
  mockDecline.mockResolvedValue(declined);
});

describe('declineChangeOrderAction', () => {
  it.each([
    ['empty reason', { ...INPUT, reason: '  ' }],
    ['non-uuid order', { ...INPUT, orderId: 'nope' }],
  ])('rejects %s as INVALID_REQUEST', async (_name, input) => {
    expect(await declineChangeOrderAction(input)).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockDecline).not.toHaveBeenCalled();
  });

  it('requires the approve_own_proposals capability, not mere participation', async () => {
    mockHasCapability.mockResolvedValue(false);
    expect(await declineChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: 'Only the client can do that.',
    });
    expect(mockHasCapability).toHaveBeenCalledWith(expect.anything(), 'approve_own_proposals', {
      companyId: COMPANY_ID,
    });
    expect(mockDecline).not.toHaveBeenCalled();
  });

  it('gives a stranger NOT_FOUND', async () => {
    mockResolveLens.mockReturnValue(null);
    expect((await declineChangeOrderAction(INPUT)).success).toBe(false);
    expect(mockHasCapability).not.toHaveBeenCalled();
  });

  it('declines the SENT order, tracks without amounts, and tells the expert the reason', async () => {
    const result = await declineChangeOrderAction(INPUT);

    expect(result).toEqual({ success: true });
    expect(mockDecline).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      orderId: ORDER_ID,
      userId: 'user-1',
      reason: REASON,
      expectedFrom: 'sent',
    });
    expect(mockTrack).toHaveBeenCalledWith('engagement_change_order_declined', {
      engagement_id: ENGAGEMENT_ID,
      change_order_id: ORDER_ID,
      pricing_method: 'fixed',
      lines_added: 1,
      lines_edited: 1,
      lines_removed: 0,
      has_price_change: true,
      initiated_by: 'client',
      distinct_id: 'user-1',
      days_to_decision: 3,
      answered_without_change_order: false,
    });
    expect(mockPublish).toHaveBeenCalledWith('change_order.declined', {
      correlationId: `${ORDER_ID}:declined`,
      engagementId: ENGAGEMENT_ID,
      changeOrderId: ORDER_ID,
      projectTitle: 'CPQ rollout',
      expertProfileId: 'expert-1',
      actorClientLabel: 'Dana @ Northwind',
      reason: REASON,
      clientCompanyName: 'Northwind',
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain(REASON);
  });

  it('maps a stale tab (order already decided) to STATUS_CHANGED', async () => {
    mockDecline.mockRejectedValue(new InvalidChangeOrderTransitionError('x'));
    expect(await declineChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
