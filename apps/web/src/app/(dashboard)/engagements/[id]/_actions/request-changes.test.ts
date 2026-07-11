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

const { mockFindEngagement, mockRequestChanges, mockCountAudit, InvalidEngagementTransitionError } =
  vi.hoisted(() => {
    class InvalidEngagementTransitionError extends Error {}
    return {
      mockFindEngagement: vi.fn(),
      mockRequestChanges: vi.fn(),
      mockCountAudit: vi.fn(),
      InvalidEngagementTransitionError,
    };
  });

vi.mock('@balo/db', () => ({
  engagementsRepository: {
    findEngagementWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
    requestChanges: (...a: unknown[]) => mockRequestChanges(...a),
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

import { requestProjectChangesAction } from './request-changes';
import { revalidatePath } from 'next/cache';

const NOTE = 'The report export is missing the Q3 totals.';
const INPUT = { engagementId: ENGAGEMENT_ID, note: NOTE };

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
      agency: { id: 'ag-1', name: 'CloudPeak Consulting' },
      headline: null,
      type: 'agency',
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
  mockRequestChanges.mockResolvedValue({
    status: 'active',
    changeRequestedAt: new Date('2026-07-06T09:00:00Z'),
  });
  mockCountAudit.mockResolvedValue(2);
});

describe('requestProjectChangesAction', () => {
  it('rejects an empty / whitespace-only note as INVALID_REQUEST', async () => {
    expect(await requestProjectChangesAction({ engagementId: ENGAGEMENT_ID, note: '   ' })).toEqual(
      {
        success: false,
        error: 'Invalid request.',
      }
    );
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('returns ONLY_CLIENT for a non-client lens', async () => {
    mockResolveLens.mockReturnValue({ lens: 'expert', archetype: 'participant' });
    expect(await requestProjectChangesAction(INPUT)).toEqual({
      success: false,
      error: 'Only the client can do that.',
    });
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('requests changes: passes the note, tracks CHANGES_REQUESTED, publishes to the expert (+admins), revalidates', async () => {
    const result = await requestProjectChangesAction(INPUT);
    expect(result).toEqual({ success: true });
    expect(mockRequestChanges).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      userId: 'client-1',
      note: NOTE,
    });

    expect(mockTrack).toHaveBeenCalledWith(
      'engagement_changes_requested',
      expect.objectContaining({
        engagement_id: ENGAGEMENT_ID,
        review_cycle: 2,
        distinct_id: 'client-1',
        days_in_review: expect.any(Number),
      })
    );

    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.changes_requested',
      expect.objectContaining({
        correlationId: `${ENGAGEMENT_ID}:changes_requested:${new Date('2026-07-06T09:00:00Z').getTime()}`,
        engagementId: ENGAGEMENT_ID,
        expertProfileId: 'expert-1',
        actorClientLabel: 'Dana @ Northwind Industrial',
        projectTitle: 'CPQ implementation',
        note: NOTE,
        reviewDays: 7,
        reviewCycle: 2,
      })
    );

    expect(revalidatePath).toHaveBeenCalledWith(`/engagements/${ENGAGEMENT_ID}`);
  });

  it('trims the note before persisting + publishing', async () => {
    await requestProjectChangesAction({ engagementId: ENGAGEMENT_ID, note: `  ${NOTE}  ` });
    expect(mockRequestChanges).toHaveBeenCalledWith(expect.objectContaining({ note: NOTE }));
  });

  it('maps InvalidEngagementTransitionError from the repo to STATUS_CHANGED', async () => {
    mockRequestChanges.mockRejectedValue(new InvalidEngagementTransitionError('x'));
    expect(await requestProjectChangesAction(INPUT)).toEqual({
      success: false,
      error: "This project's status changed. Refresh and try again.",
    });
  });
});
