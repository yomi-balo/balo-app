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
vi.mock('@/lib/authz/engagement', () => ({
  hasExpertDeliveryCapability: (...a: unknown[]) => mockHasExpertCapability(...a),
}));

const { mockFindEngagement, mockWrite, mockFindOwner, mockFindUser, TimeEntryWriteRefusedError } =
  vi.hoisted(() => {
    class TimeEntryWriteRefusedError extends Error {
      constructor(public readonly reason: string) {
        super(reason);
      }
    }
    return {
      mockFindEngagement: vi.fn(),
      mockWrite: vi.fn(),
      mockFindOwner: vi.fn(),
      mockFindUser: vi.fn(),
      TimeEntryWriteRefusedError,
    };
  });

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
  usersRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
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

import { logTimeAction } from './log-time';

const INPUT = {
  engagementId: ENGAGEMENT_ID,
  milestoneId: MILESTONE_ID,
  minutes: 90,
  note: 'Mapped the flows',
};

const entry = { id: ENTRY_ID, engagementMilestoneId: MILESTONE_ID, minutes: 90 };

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
  mockWrite.mockResolvedValue(written());
  mockFindOwner.mockResolvedValue({ id: 'owner-1' });
  mockFindUser.mockResolvedValue({ id: CHARLES.id, timezone: 'Australia/Melbourne' });
});

describe('logTimeAction', () => {
  it.each([
    ['a blank note', { note: '   ' }],
    ['a minute count off the quarter hour', { minutes: 20 }],
    ['zero minutes', { minutes: 0 }],
    ['more than a day', { minutes: 1455 }],
    ['a non-integer', { minutes: 22.5 }],
    ['a non-uuid milestone', { milestoneId: 'x' }],
  ])('rejects %s as an invalid request', async (_label, over) => {
    expect(await logTimeAction({ ...INPUT, ...over })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses a caller without manage_engagement', async () => {
    mockHasExpertCapability.mockResolvedValue(false);
    expect(await logTimeAction(INPUT)).toEqual({
      success: false,
      error: 'Only the delivering expert can do that.',
    });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses a milestone that is not part of the engagement', async () => {
    const result = await logTimeAction({
      ...INPUT,
      milestoneId: 'b0000000-0000-4000-8000-0000000000ff',
    });
    expect(result).toMatchObject({ success: false });
    expect(JSON.stringify(result)).toContain('no longer part of this engagement');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses a fixed-price project', async () => {
    mockFindEngagement.mockResolvedValue(
      makeProject({ milestones: [makeMilestone({ id: MILESTONE_ID })] })
    );
    expect(await logTimeAction(INPUT)).toEqual({
      success: false,
      error: 'Time is only logged on time and materials projects.',
    });
  });

  it("logs the entry dated today in the author's time zone, tracks it and does not notify below the estimate", async () => {
    // 23:30Z on 14 Oct is 10:30 on 15 Oct in Melbourne (AEDT, UTC+11).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T23:30:00Z'));
    try {
      expect(await logTimeAction(INPUT)).toEqual({ success: true });
    } finally {
      vi.useRealTimers();
    }
    expect(mockWrite).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      userId: CHARLES.id,
      minutes: 90,
      note: 'Mapped the flows',
      workedOn: '2026-10-15',
    });
    expect(mockFindUser).toHaveBeenCalledWith(CHARLES.id);
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('engagement_time_logged', {
      engagement_id: ENGAGEMENT_ID,
      milestone_id: MILESTONE_ID,
      minutes: 90,
      crossed_estimate: false,
      milestone_pct_of_estimate: 94,
      distinct_id: CHARLES.id,
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('dates the entry in UTC when the author has no time zone', async () => {
    mockFindUser.mockResolvedValue({ id: CHARLES.id, timezone: null });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T23:30:00Z'));
    try {
      expect(await logTimeAction(INPUT)).toEqual({ success: true });
    } finally {
      vi.useRealTimers();
    }
    expect(mockWrite).toHaveBeenCalledWith(expect.objectContaining({ workedOn: '2026-10-14' }));
  });

  it('publishes the estimate-exceeded notice once, with hours only, on a first crossing', async () => {
    mockWrite.mockResolvedValue(
      written({ estimateExceeded: true, loggedAfterMinutes: 510, milestonesOverCount: 2 })
    );
    expect(await logTimeAction(INPUT)).toEqual({ success: true });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith('engagement.milestone_estimate_exceeded', {
      correlationId: `${MILESTONE_ID}:estimate_exceeded:480`,
      engagementId: ENGAGEMENT_ID,
      milestoneId: MILESTONE_ID,
      recipientId: 'owner-1',
      expertPartyLabel: 'Charles Ng',
      actorExpertLabel: 'Charles',
      projectTitle: 'CPQ rollout',
      milestoneTitle: 'Discovery',
      loggedHoursLabel: '8.5 hrs',
      estimatedHoursLabel: '8 hrs',
    });
    expect(mockTrack).toHaveBeenCalledWith('engagement_milestone_estimate_exceeded', {
      engagement_id: ENGAGEMENT_ID,
      milestone_id: MILESTONE_ID,
      milestones_over_count: 2,
      distinct_id: CHARLES.id,
    });
  });

  it.each([
    ['not_time_and_materials', 'Time is only logged on time and materials projects.'],
    ['milestone_not_in_progress', "Time can only be logged on a milestone that's in progress."],
    [
      'milestone_not_found',
      'This milestone is no longer part of this engagement — refresh and try again.',
    ],
    ['entry_not_found', 'This time entry has changed or been removed. Refresh and try again.'],
  ])('maps the %s refusal to friendly copy without notifying', async (reason, error) => {
    mockWrite.mockRejectedValue(new TimeEntryWriteRefusedError(reason));
    expect(await logTimeAction(INPUT)).toEqual({ success: false, error });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
