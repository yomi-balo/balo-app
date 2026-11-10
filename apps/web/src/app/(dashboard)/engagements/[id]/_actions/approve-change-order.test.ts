import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CHARLES,
  FIXTURE_COMPANY_ID as COMPANY_ID,
  FIXTURE_ENGAGEMENT_ID as ENGAGEMENT_ID,
  makeLine,
  makeMilestone,
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

const {
  mockFindEngagement,
  mockApprove,
  InvalidChangeOrderTransitionError,
  ChangeOrderCoherenceError,
} = vi.hoisted(() => {
  class InvalidChangeOrderTransitionError extends Error {}
  class ChangeOrderCoherenceError extends Error {
    constructor(public readonly rule: string) {
      super(rule);
    }
  }
  return {
    mockFindEngagement: vi.fn(),
    mockApprove: vi.fn(),
    InvalidChangeOrderTransitionError,
    ChangeOrderCoherenceError,
  };
});

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    findWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  engagementChangeOrdersRepository: { approve: (...a: unknown[]) => mockApprove(...a) },
  companiesRepository: { findOwnerByCompanyId: vi.fn() },
  InvalidChangeOrderTransitionError,
  ChangeOrderCoherenceError,
  ChangeOrderAlreadyOpenError: class extends Error {},
  ChangeOrderNotFoundError: class extends Error {},
  ChangeOrderPendingError: class extends Error {},
  MilestonesIncompleteError: class extends Error {},
  InvalidEngagementTransitionError: class extends Error {},
  EngagementNotActiveError: class extends Error {},
  InvalidMilestoneTransitionError: class extends Error {},
  MilestoneChangePendingError: class extends Error {},
}));

const mockLoadSettlement = vi.fn();
vi.mock('@/lib/engagement/change-order-settlement', () => ({
  loadProjectSettlement: (...a: unknown[]) => mockLoadSettlement(...a),
}));

const mockRaiseAlert = vi.fn();
vi.mock('@/lib/admin-alerts/raise-admin-alert', () => ({
  raiseAdminAlert: (...a: unknown[]) => mockRaiseAlert(...a),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ENGAGEMENT_SERVER_EVENTS: {
    CHANGE_ORDER_APPROVED: 'engagement_change_order_approved',
    MILESTONE_ESTIMATE_EXCEEDED: 'engagement_milestone_estimate_exceeded',
  },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { approveChangeOrderAction } from './approve-change-order';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const INPUT = { engagementId: ENGAGEMENT_ID, orderId: ORDER_ID };

function approval(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order: makeOrder({
      id: ORDER_ID,
      status: 'approved',
      priceDeltaCents: 100_000,
      requestedAt: new Date('2026-10-10T00:00:00Z'),
      requestedByUserId: 'user-1',
      sentAt: new Date('2026-10-12T00:00:00Z'),
      sentByUserId: CHARLES.id,
      decidedAt: new Date('2026-10-15T09:00:00Z'),
      decidedByUserId: 'user-1',
      lines: [makeLine({ op: 'add', estimatedMinutes: 600 })],
    }),
    appliedMilestoneIds: ['ms-new'],
    previousEffectivePriceCents: 1_000_000,
    effectivePriceCents: 1_100_000,
    estimatesExceeded: [],
    milestonesOverCount: 0,
    ...over,
  };
}

function settlement(creditRequiredClientCents: number): Record<string, unknown> {
  return { creditRequiredClientCents };
}

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
  mockApprove.mockResolvedValue(approval());
  mockLoadSettlement.mockResolvedValue(settlement(0));
  mockRaiseAlert.mockResolvedValue(undefined);
});

describe('approveChangeOrderAction', () => {
  it('rejects invalid input', async () => {
    expect(await approveChangeOrderAction({ ...INPUT, orderId: 'x' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('requires approve_own_proposals on the engagement company', async () => {
    mockHasCapability.mockResolvedValue(false);
    expect(await approveChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: 'Only the client can do that.',
    });
    expect(mockHasCapability).toHaveBeenCalledWith(expect.anything(), 'approve_own_proposals', {
      companyId: COMPANY_ID,
    });
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('approves, tracks without amounts, and tells the expert with EXPERT figures only', async () => {
    expect(await approveChangeOrderAction(INPUT)).toEqual({ success: true });

    expect(mockApprove).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      orderId: ORDER_ID,
      userId: 'user-1',
    });
    expect(mockTrack).toHaveBeenCalledWith('engagement_change_order_approved', {
      engagement_id: ENGAGEMENT_ID,
      change_order_id: ORDER_ID,
      pricing_method: 'fixed',
      lines_added: 1,
      lines_edited: 0,
      lines_removed: 0,
      has_price_change: true,
      initiated_by: 'client',
      distinct_id: 'user-1',
      days_to_decision: 3,
    });
    expect(mockPublish).toHaveBeenCalledWith('change_order.approved', {
      correlationId: `${ORDER_ID}:approved`,
      engagementId: ENGAGEMENT_ID,
      changeOrderId: ORDER_ID,
      projectTitle: 'CPQ rollout',
      expertProfileId: 'expert-1',
      actorClientLabel: 'Dana @ Northwind',
      clientCompanyName: 'Northwind',
      pricingMethod: 'fixed',
      approvedOn: '15 Oct',
      expertPriceChangeLabel: 'A$10,000 → A$11,000 (+A$1,000)',
      expertPartyLabel: 'Charles Ng',
    });
    const payload = JSON.stringify(mockPublish.mock.calls);
    expect(payload).not.toContain('A$12,500');
    expect(payload).not.toContain('A$13,750');
    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('raises the credit-needed alert when the final invoice is below zero', async () => {
    mockLoadSettlement.mockResolvedValue(settlement(500_000));

    await approveChangeOrderAction(INPUT);

    expect(mockLoadSettlement).toHaveBeenCalledWith(ENGAGEMENT_ID);
    expect(mockRaiseAlert).toHaveBeenCalledTimes(1);
    const [alert] = mockRaiseAlert.mock.calls[0] ?? [];
    expect(alert).toMatchObject({
      kind: 'project.change_order_credit_required',
      entityType: 'engagement',
      entityId: ENGAGEMENT_ID,
      detail: {
        title: 'Credit needed on CPQ rollout',
        evidence: expect.stringContaining('Dana @ Northwind approved a change on 15 Oct'),
        facts: [
          ['Client', 'Northwind'],
          ['Expert', 'Charles Ng'],
          ['Approved', '15 Oct'],
        ],
      },
    });
    expect(JSON.stringify(alert)).not.toMatch(/\d{3},\d{3}|A\$/);
  });

  it('raises nothing when the new price is at or above what was invoiced', async () => {
    await approveChangeOrderAction(INPUT);
    expect(mockRaiseAlert).not.toHaveBeenCalled();
  });

  it('still succeeds, and logs, when the settlement cannot be read after the commit', async () => {
    mockLoadSettlement.mockRejectedValue(new Error('terms unavailable'));

    expect(await approveChangeOrderAction(INPUT)).toEqual({ success: true });
    expect(mockRaiseAlert).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      'Failed to evaluate change order credit alert',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, error: 'terms unavailable' })
    );
  });

  it('time and materials: tells the expert the estimate, and never evaluates a credit', async () => {
    mockFindEngagement.mockResolvedValue(
      makeProject({
        pricingMethod: 'tm',
        milestones: [makeMilestone({ estimatedMinutes: 3000 })],
      })
    );
    mockApprove.mockResolvedValue(
      approval({
        order: makeOrder({
          id: ORDER_ID,
          status: 'approved',
          sentAt: new Date('2026-10-12T00:00:00Z'),
          decidedAt: new Date('2026-10-15T09:00:00Z'),
          lines: [makeLine({ op: 'add', estimatedMinutes: 600 })],
        }),
        previousEffectivePriceCents: 1_000_000,
        effectivePriceCents: 1_000_000,
      })
    );

    await approveChangeOrderAction(INPUT);

    expect(mockPublish).toHaveBeenCalledWith(
      'change_order.approved',
      expect.objectContaining({
        pricingMethod: 'tm',
        estimateChangeLabel: '50 hrs → 60 hrs (+10 hrs)',
      })
    );
    expect(mockPublish.mock.calls[0]?.[1]).not.toHaveProperty('expertPriceChangeLabel');
    expect(mockLoadSettlement).not.toHaveBeenCalled();
    expect(mockRaiseAlert).not.toHaveBeenCalled();
  });

  it('time and materials: tells the client when time logged since the send overtook an approved raise', async () => {
    mockFindEngagement.mockResolvedValue(
      makeProject({
        pricingMethod: 'tm',
        milestones: [makeMilestone({ id: 'ms-1', title: 'Discovery', estimatedMinutes: 300 })],
      })
    );
    mockApprove.mockResolvedValue(
      approval({
        estimatesExceeded: [
          { id: 'ms-1', title: 'Discovery', estimatedMinutes: 300, loggedMinutes: 360 },
        ],
        milestonesOverCount: 1,
      })
    );

    await approveChangeOrderAction(INPUT);

    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.milestone_estimate_exceeded',
      expect.objectContaining({
        correlationId: 'ms-1:estimate_exceeded:300',
        milestoneId: 'ms-1',
        milestoneTitle: 'Discovery',
        loggedHoursLabel: '6 hrs',
        estimatedHoursLabel: '5 hrs',
      })
    );
    expect(mockTrack).toHaveBeenCalledWith('engagement_milestone_estimate_exceeded', {
      engagement_id: ENGAGEMENT_ID,
      milestone_id: 'ms-1',
      milestones_over_count: 1,
      distinct_id: expect.any(String),
    });
  });

  it('sends no over-estimate notice when the approval leaves every estimate covered', async () => {
    mockFindEngagement.mockResolvedValue(
      makeProject({ pricingMethod: 'tm', milestones: [makeMilestone({ estimatedMinutes: 3000 })] })
    );
    mockApprove.mockResolvedValue(approval());

    await approveChangeOrderAction(INPUT);

    expect(mockPublish).not.toHaveBeenCalledWith(
      'engagement.milestone_estimate_exceeded',
      expect.anything()
    );
  });

  it('time and materials: a cap that moved reads as the new cap, in expert figures', async () => {
    mockFindEngagement.mockResolvedValue(
      makeProject({
        pricingMethod: 'tm',
        milestones: [makeMilestone({ estimatedMinutes: 3000 })],
      })
    );
    mockApprove.mockResolvedValue(approval());

    await approveChangeOrderAction(INPUT);

    expect(mockPublish).toHaveBeenCalledWith(
      'change_order.approved',
      expect.objectContaining({
        pricingMethod: 'tm',
        estimateChangeLabel: '50 hrs → 60 hrs (+10 hrs)',
        expertPriceChangeLabel: 'Cap A$10,000 → A$11,000 (+A$1,000)',
      })
    );
    expect(mockLoadSettlement).not.toHaveBeenCalled();
  });

  it('maps a stale line (coherence re-check at approval) to its message and writes nothing else', async () => {
    mockApprove.mockRejectedValue(new ChangeOrderCoherenceError('line_target_not_live'));
    expect(await approveChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: 'The delivery plan changed since you loaded the page. Refresh and try again.',
    });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockRaiseAlert).not.toHaveBeenCalled();
  });

  it('maps an order that is no longer sent to STATUS_CHANGED', async () => {
    mockApprove.mockRejectedValue(new InvalidChangeOrderTransitionError('x'));
    expect(await approveChangeOrderAction(INPUT)).toEqual({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
  });
});
