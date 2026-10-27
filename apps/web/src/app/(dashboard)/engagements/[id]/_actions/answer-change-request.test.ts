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

const {
  mockFindEngagement,
  mockDecline,
  mockFindOwner,
  mockFindMembers,
  ChangeOrderNotFoundError,
} = vi.hoisted(() => {
  class ChangeOrderNotFoundError extends Error {}
  return {
    mockFindEngagement: vi.fn(),
    mockDecline: vi.fn(),
    mockFindOwner: vi.fn(),
    mockFindMembers: vi.fn(),
    ChangeOrderNotFoundError,
  };
});

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    findWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  engagementChangeOrdersRepository: { decline: (...a: unknown[]) => mockDecline(...a) },
  companiesRepository: {
    findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a),
    findWithMembers: (...a: unknown[]) => mockFindMembers(...a),
  },
  ChangeOrderNotFoundError,
  ChangeOrderAlreadyOpenError: class extends Error {},
  ChangeOrderCoherenceError: class extends Error {},
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
  ENGAGEMENT_SERVER_EVENTS: { CHANGE_ORDER_DECLINED: 'engagement_change_order_declined' },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { answerChangeRequestAction } from './answer-change-request';
import { log } from '@/lib/logging';

const ANSWER = 'That is already covered by the existing reports milestone.';
const INPUT = { engagementId: ENGAGEMENT_ID, orderId: ORDER_ID, answer: ANSWER };

const answered = makeOrder({
  id: ORDER_ID,
  status: 'declined',
  requestedAt: new Date('2026-10-10T00:00:00Z'),
  requestedByUserId: DANA.id,
  declineReason: ANSWER,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
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
  mockDecline.mockResolvedValue(answered);
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
  mockFindMembers.mockResolvedValue({ members: [{ userId: DANA.id }] });
});

describe('answerChangeRequestAction', () => {
  it('rejects an empty answer', async () => {
    expect(await answerChangeRequestAction({ ...INPUT, answer: '   ' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockDecline).not.toHaveBeenCalled();
  });

  it('gates on manage_engagement for the delivering expert profile', async () => {
    await answerChangeRequestAction(INPUT);
    expect(mockHasExpertCapability).toHaveBeenCalledWith(
      expect.objectContaining({ id: CHARLES.id }),
      'manage_engagement',
      'expert-1',
      { contextType: 'project', contextId: ENGAGEMENT_ID }
    );
  });

  it('names an agency admin as the answerer and tracks acting_as agency_admin', async () => {
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
    await answerChangeRequestAction(INPUT);
    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_change_order_declined',
      expect.objectContaining({ acting_as: 'agency_admin' })
    );
    expect(mockPublish.mock.calls[0]?.[1]).toMatchObject({ actorExpertLabel: 'Dana @ CloudPeak' });
  });

  it('refuses a party who does not hold the capability (an agency colleague, say)', async () => {
    mockHasExpertCapability.mockResolvedValue(false);
    expect(await answerChangeRequestAction(INPUT)).toEqual({
      success: false,
      error: 'Only the delivering expert can do that.',
    });
    expect(mockDecline).not.toHaveBeenCalled();
  });

  it('gives a non-party the same NOT_FOUND as a missing engagement', async () => {
    mockHasExpertCapability.mockResolvedValue(false);
    mockResolveLens.mockReturnValue(null);
    expect(await answerChangeRequestAction(INPUT)).toEqual({
      success: false,
      error: 'This engagement could not be found.',
    });
  });

  it('refuses a project that is not active', async () => {
    mockFindEngagement.mockResolvedValue(makeProject({ status: 'completed' }));
    expect(await answerChangeRequestAction(INPUT)).toEqual({
      success: false,
      error: "This project isn't active.",
    });
  });

  it('answers the REQUEST, tracks it as answered, and tells the client owner', async () => {
    const result = await answerChangeRequestAction({ ...INPUT, answer: `  ${ANSWER} ` });

    expect(result).toEqual({ success: true });
    expect(mockDecline).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      orderId: ORDER_ID,
      userId: CHARLES.id,
      reason: ANSWER,
      expectedFrom: 'requested',
    });
    expect(mockTrack).toHaveBeenCalledWith('engagement_change_order_declined', {
      engagement_id: ENGAGEMENT_ID,
      change_order_id: ORDER_ID,
      pricing_method: 'fixed',
      lines_added: 0,
      lines_edited: 0,
      lines_removed: 0,
      has_price_change: false,
      initiated_by: 'client',
      distinct_id: CHARLES.id,
      days_to_decision: 2,
      answered_without_change_order: true,
      acting_as: 'delivering_expert',
    });
    expect(mockPublish).toHaveBeenCalledWith('change_order.answered', {
      correlationId: `${ORDER_ID}:answered`,
      engagementId: ENGAGEMENT_ID,
      changeOrderId: ORDER_ID,
      projectTitle: 'CPQ rollout',
      recipientId: 'owner-1',
      actorExpertLabel: 'Charles',
      answer: ANSWER,
      requestedByUserId: DANA.id,
    });
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain(ANSWER);
  });

  it('leaves the requester out when they have left the company or are the owner', async () => {
    mockFindMembers.mockResolvedValue({ members: [{ userId: 'someone-else' }] });
    await answerChangeRequestAction(INPUT);
    expect(mockPublish.mock.calls[0]?.[1]).not.toHaveProperty('requestedByUserId');

    mockPublish.mockClear();
    mockFindMembers.mockResolvedValue({ members: [{ userId: DANA.id }] });
    mockFindOwner.mockResolvedValue({ id: DANA.id });
    await answerChangeRequestAction(INPUT);
    expect(mockPublish.mock.calls[0]?.[1]).not.toHaveProperty('requestedByUserId');
  });

  it('still publishes (client rules skip) when the client owner cannot be found', async () => {
    mockFindOwner.mockRejectedValue(new Error('no owner'));
    await answerChangeRequestAction(INPUT);
    expect(mockPublish).toHaveBeenCalledWith(
      'change_order.answered',
      expect.objectContaining({ recipientId: undefined })
    );
  });

  it('maps a vanished order to STATUS_CHANGED', async () => {
    mockDecline.mockRejectedValue(new ChangeOrderNotFoundError('x'));
    expect(await answerChangeRequestAction(INPUT)).toEqual({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
