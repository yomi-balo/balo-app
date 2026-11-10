import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CHARLES,
  FIXTURE_ENGAGEMENT_ID as ENGAGEMENT_ID,
  makeMilestone,
  makeProject,
} from '@/test/change-order-fixtures';

const MILESTONE_ID = 'b0000000-0000-4000-8000-0000000000b1';
const ENTRY_ID = 'b0000000-0000-4000-8000-0000000000e1';

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
const mockAdministersAgency = vi.fn();
vi.mock('@/lib/authz/engagement', () => ({
  hasExpertDeliveryCapability: (...a: unknown[]) => mockHasExpertCapability(...a),
  administersDeliveringAgency: (...a: unknown[]) => mockAdministersAgency(...a),
}));

const { mockFindEngagement, mockWrite, mockFindOwner, TimeEntryWriteRefusedError } = vi.hoisted(
  () => {
    class TimeEntryWriteRefusedError extends Error {
      constructor(public readonly reason: string) {
        super(reason);
      }
    }
    return {
      mockFindEngagement: vi.fn(),
      mockWrite: vi.fn(),
      mockFindOwner: vi.fn(),
      TimeEntryWriteRefusedError,
    };
  }
);

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    findWithMilestones: (...a: unknown[]) => mockFindEngagement(...a),
  },
  engagementTimeEntriesRepository: {
    log: (...a: unknown[]) => mockWrite(...a),
    update: (...a: unknown[]) => mockWrite(...a),
    remove: (...a: unknown[]) => mockWrite(...a),
  },
  companiesRepository: { findOwnerByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
  TimeEntryWriteRefusedError,
  ChangeOrderAlreadyOpenError: class extends Error {},
  ChangeOrderCoherenceError: class extends Error {},
  ChangeOrderNotFoundError: class extends Error {},
  ChangeOrderPendingError: class extends Error {},
  MilestonesIncompleteError: class extends Error {},
  InvalidEngagementTransitionError: class extends Error {},
  InvalidChangeOrderTransitionError: class extends Error {},
  EngagementNotActiveError: class extends Error {},
  InvalidMilestoneTransitionError: class extends Error {},
  MilestoneChangePendingError: class extends Error {},
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ENGAGEMENT_SERVER_EVENTS: {
    TIME_LOGGED: 'engagement_time_logged',
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

import { removeTimeEntryAction } from './remove-time-entry';

const INPUT = { engagementId: ENGAGEMENT_ID, entryId: ENTRY_ID };

const entry = {
  id: ENTRY_ID,
  engagementMilestoneId: MILESTONE_ID,
  userId: CHARLES.id,
  workedOn: '2026-10-14',
  minutes: 90,
  updatedAt: new Date('2026-10-14T03:00:00Z'),
};

const ADMIN = {
  id: 'admin-1',
  firstName: 'Dana',
  lastName: 'Lee',
  platformRole: 'user',
  companyId: 'other-company',
  expertProfileId: 'expert-2',
};

function written(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entry,
    milestone: { id: MILESTONE_ID, title: 'Discovery', estimatedMinutes: 480 },
    loggedAfterMinutes: 450,
    estimateExceeded: false,
    milestonesOverCount: 0,
    ...over,
  };
}

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
  mockFindEngagement.mockResolvedValue(
    makeProject({
      pricingMethod: 'tm',
      milestones: [makeMilestone({ id: MILESTONE_ID, status: 'in_progress' })],
    })
  );
  mockResolveLens.mockReturnValue({ lens: 'expert', archetype: 'participant' });
  mockHasExpertCapability.mockResolvedValue(true);
  mockAdministersAgency.mockResolvedValue(false);
  mockWrite.mockResolvedValue(written());
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
});

describe('removeTimeEntryAction', () => {
  it('rejects a non-uuid entry', async () => {
    expect(await removeTimeEntryAction({ ...INPUT, entryId: 'x' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
  });

  it('refuses a caller without manage_engagement', async () => {
    mockHasExpertCapability.mockResolvedValue(false);
    expect(await removeTimeEntryAction(INPUT)).toMatchObject({ success: false });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('lets an agency admin remove any author entry', async () => {
    mockRequireUser.mockResolvedValue(ADMIN);
    mockAdministersAgency.mockResolvedValue(true);
    mockWrite.mockResolvedValue(entry);
    expect(await removeTimeEntryAction(INPUT)).toEqual({ success: true });
    expect(mockWrite).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      entryId: ENTRY_ID,
      userId: 'admin-1',
      authorScope: 'any',
    });
  });

  it('gives a delivering expert who administers the agency any-entry scope', async () => {
    mockAdministersAgency.mockResolvedValue(true);
    mockWrite.mockResolvedValue(entry);
    expect(await removeTimeEntryAction(INPUT)).toEqual({ success: true });
    expect(mockWrite).toHaveBeenCalledWith(expect.objectContaining({ authorScope: 'any' }));
  });

  it("tells the author when someone else's entry is removed", async () => {
    mockRequireUser.mockResolvedValue(ADMIN);
    mockWrite.mockResolvedValue(entry);
    expect(await removeTimeEntryAction(INPUT)).toEqual({ success: true });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.time_entry_changed',
      expect.objectContaining({
        correlationId: `${ENTRY_ID}:removed:${entry.updatedAt.getTime()}`,
        userId: CHARLES.id,
        actorUserId: 'admin-1',
        change: 'removed',
        workedOnLabel: '14 Oct',
        hoursLabel: '1.5 hrs',
      })
    );
  });

  it('deletes the entry as the actor and sends no notice', async () => {
    mockWrite.mockResolvedValue(entry);
    expect(await removeTimeEntryAction(INPUT)).toEqual({ success: true });
    expect(mockWrite).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      entryId: ENTRY_ID,
      userId: CHARLES.id,
      authorScope: 'own',
    });
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('maps a missing or foreign entry to the shared refusal copy', async () => {
    mockWrite.mockRejectedValue(new TimeEntryWriteRefusedError('entry_not_found'));
    expect(await removeTimeEntryAction(INPUT)).toEqual({
      success: false,
      error: 'This time entry has changed or been removed. Refresh and try again.',
    });
  });
});
