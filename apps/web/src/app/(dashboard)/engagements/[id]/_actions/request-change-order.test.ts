import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FIXTURE_COMPANY_ID as COMPANY_ID,
  FIXTURE_ENGAGEMENT_ID as ENGAGEMENT_ID,
  makeOrder,
  makeProject,
} from '@/test/change-order-fixtures';

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

const { mockFindEngagement, mockRequestByClient, ChangeOrderAlreadyOpenError } = vi.hoisted(() => {
  class ChangeOrderAlreadyOpenError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockRequestByClient: vi.fn(),
    ChangeOrderAlreadyOpenError,
  };
});

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    findWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  engagementChangeOrdersRepository: {
    requestByClient: (...a: unknown[]) => mockRequestByClient(...a),
  },
  companiesRepository: { findOwnerByCompanyId: vi.fn() },
  ChangeOrderAlreadyOpenError,
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
  ENGAGEMENT_SERVER_EVENTS: { CHANGE_ORDER_REQUESTED: 'engagement_change_order_requested' },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { requestChangeOrderAction } from './request-change-order';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const NOTE = 'Can we add a reporting dashboard?';
const INPUT = { engagementId: ENGAGEMENT_ID, note: NOTE };

beforeEach(() => {
  vi.clearAllMocks();
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
  mockRequestByClient.mockResolvedValue(makeOrder({ id: 'co-1', status: 'requested' }));
});

describe('requestChangeOrderAction', () => {
  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await requestChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockRequestByClient).not.toHaveBeenCalled();
  });

  it.each([
    ['whitespace-only note', { ...INPUT, note: '   ' }],
    ['over-long note', { ...INPUT, note: 'x'.repeat(2001) }],
    ['non-uuid engagement', { ...INPUT, engagementId: 'nope' }],
  ])('rejects a %s as INVALID_REQUEST', async (_name, input) => {
    expect(await requestChangeOrderAction(input)).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockRequestByClient).not.toHaveBeenCalled();
  });

  it('gives a stranger the same NOT_FOUND as a missing engagement', async () => {
    mockResolveLens.mockReturnValue(null);
    expect(await requestChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: 'This engagement could not be found.',
    });
    mockFindEngagement.mockResolvedValue(undefined);
    expect(await requestChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: 'This engagement could not be found.',
    });
    expect(mockRequestByClient).not.toHaveBeenCalled();
  });

  it('refuses a caller without the participate capability on the engagement company', async () => {
    mockHasCapability.mockResolvedValue(false);
    expect(await requestChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: 'Only the client can do that.',
    });
    expect(mockHasCapability).toHaveBeenCalledWith(expect.anything(), 'participate', {
      companyId: COMPANY_ID,
    });
    expect(mockRequestByClient).not.toHaveBeenCalled();
  });

  it('refuses a project that is not active', async () => {
    mockFindEngagement.mockResolvedValue(makeProject({ status: 'pending_acceptance' }));
    expect(await requestChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: "This project isn't active.",
    });
    expect(mockRequestByClient).not.toHaveBeenCalled();
  });

  it('opens the request, tracks it without amounts, and publishes to the expert and admins', async () => {
    const result = await requestChangeOrderAction({ ...INPUT, note: `  ${NOTE}  ` });

    expect(result).toEqual({ success: true });
    expect(mockRequestByClient).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      userId: 'user-1',
      note: NOTE,
    });
    expect(mockTrack).toHaveBeenCalledWith('engagement_change_order_requested', {
      engagement_id: ENGAGEMENT_ID,
      change_order_id: 'co-1',
      pricing_method: 'fixed',
      initiated_by: 'client',
      distinct_id: 'user-1',
    });
    expect(mockPublish).toHaveBeenCalledWith('change_order.requested', {
      correlationId: 'co-1:requested',
      engagementId: ENGAGEMENT_ID,
      changeOrderId: 'co-1',
      projectTitle: 'CPQ rollout',
      expertProfileId: 'expert-1',
      actorClientLabel: 'Dana @ Northwind',
      note: NOTE,
      expertPartyLabel: 'Charles Ng',
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}/change-order`);
  });

  it('never logs the note', async () => {
    await requestChangeOrderAction(INPUT);
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain(NOTE);
  });

  it('maps a second open order to CHANGE_ALREADY_OPEN without tracking or publishing', async () => {
    mockRequestByClient.mockRejectedValue(new ChangeOrderAlreadyOpenError('x'));
    expect(await requestChangeOrderAction(INPUT)).toEqual({
      success: false,
      error:
        "There's already a change open on this project. You can start another once it's decided.",
    });
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('turns an unexpected failure into the generic message and logs without the note', async () => {
    mockRequestByClient.mockRejectedValue(new Error('db down'));
    expect(await requestChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to request change order',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, error: 'db down' })
    );
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain(NOTE);
  });
});
