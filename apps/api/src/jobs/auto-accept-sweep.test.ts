import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────
const {
  mockListPending,
  mockAccept,
  mockFindWithMilestones,
  mockFindOwner,
  mockCountAudit,
  mockPublish,
  mockTrackServer,
} = vi.hoisted(() => ({
  mockListPending: vi.fn(),
  mockAccept: vi.fn(),
  mockFindWithMilestones: vi.fn(),
  mockFindOwner: vi.fn(),
  mockCountAudit: vi.fn(),
  mockPublish: vi.fn(),
  mockTrackServer: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  // BAL-417: the project delivery lifecycle moved off `engagementsRepository` (now the
  // type-agnostic supertype) onto `projectEngagementsRepository`.
  projectEngagementsRepository: {
    listPendingAutoAccept: mockListPending,
    acceptCompletion: mockAccept,
    findWithMilestones: mockFindWithMilestones,
  },
  companiesRepository: { findOwnerByCompanyId: mockFindOwner },
  auditEventsRepository: { countByEntityAndAction: mockCountAudit },
  AUTO_ACCEPT_DAYS: 7,
}));

// `@balo/shared/parties` is pure — use the real expertPartyDisplayName (no mock).

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  ENGAGEMENT_SERVER_EVENTS: {
    ACCEPTED: 'engagement_accepted',
    REVIEW_REMINDER_SENT: 'engagement_review_reminder_sent',
  },
}));

vi.mock('../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));

vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn(() => ({ add: vi.fn() })) }));
vi.mock('bullmq', () => ({
  Worker: class MockWorker {},
}));

import type { ProjectEngagementRow, ProjectEngagementWithMilestones } from '@balo/db';
import {
  runDeliveryReviewSweep,
  REVIEW_REMINDER_LEAD_DAYS,
  DELIVERY_REVIEW_SWEEP_CRON,
} from './auto-accept-sweep.js';

// ── Fixtures ───────────────────────────────────────────────────
// Typed `Partial<…>` against the BAL-417 shapes rather than `Record<string, unknown>`:
// the object literals are then excess-property-checked, so a field the split renamed or
// relocated fails here instead of silently feeding the sweep a shape production no
// longer produces. `status` is the 4-value `ProjectDeliveryStatus`.
const REQUESTED_07_03 = new Date('2026-07-03T00:00:00Z');
const REQUESTED_07_06 = new Date('2026-07-06T00:00:00Z');

function engRow(over: Partial<ProjectEngagementRow> = {}): Partial<ProjectEngagementRow> {
  return {
    id: 'eng-1',
    expertProfileId: 'ep-1',
    companyId: 'co-1',
    completionRequestedAt: REQUESTED_07_03,
    activatedAt: new Date('2026-06-01T00:00:00Z'),
    createdAt: new Date('2026-06-01T00:00:00Z'),
    acceptedAt: null,
    status: 'pending_acceptance',
    ...over,
  };
}

/**
 * The sweep reads only `milestones.length` (it becomes the `milestonesTotal` payload
 * field), so a length-`n` stub is sufficient. The single cast is confined here rather
 * than spread across the fixtures as 19-field milestone literals that would assert
 * nothing — `engagement_milestones` is untouched by the BAL-417 split.
 */
function milestoneStubs(n: number): ProjectEngagementWithMilestones['milestones'] {
  return Array.from({ length: n }) as ProjectEngagementWithMilestones['milestones'];
}

function hydrated(
  over: Partial<ProjectEngagementWithMilestones> = {}
): Partial<ProjectEngagementWithMilestones> {
  return {
    id: 'eng-1',
    company: { id: 'co-1', name: 'Northwind Industrial' },
    expertProfile: {
      id: 'ep-1',
      type: 'agency',
      agencyId: 'ag-1',
      headline: null,
      user: { id: 'u-ex', firstName: 'Priya', lastName: 'Sharma', avatarUrl: null },
      agency: { id: 'ag-1', name: 'CloudPeak Consulting', logoUrl: null },
    },
    projectRequest: { id: 'pr-1', title: 'CPQ implementation' },
    milestones: milestoneStubs(4),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCountAudit.mockResolvedValue(1);
});

describe('runDeliveryReviewSweep — auto-accept pass', () => {
  it('auto-accepts a past-window engagement and fans out the notifications + analytics', async () => {
    mockListPending.mockResolvedValueOnce([engRow()]).mockResolvedValueOnce([]);
    mockAccept.mockResolvedValue(
      engRow({ status: 'completed', acceptedAt: new Date('2026-07-10T12:00:00Z') })
    );
    mockFindWithMilestones.mockResolvedValue(hydrated());
    mockFindOwner.mockResolvedValue({ id: 'owner-1' });

    const now = new Date('2026-07-10T12:00:00Z'); // 7 days after 07-03
    const result = await runDeliveryReviewSweep(now);

    expect(result).toEqual({ accepted: 1, reminded: 0 });
    expect(mockAccept).toHaveBeenCalledWith({ engagementId: 'eng-1', method: 'auto' });
    // The accept-pass cutoff is now − AUTO_ACCEPT_DAYS; reminder cutoff is now − (7−2).
    expect(mockListPending.mock.calls[0]?.[0]).toEqual(new Date('2026-07-03T12:00:00Z'));
    expect(mockListPending.mock.calls[1]?.[0]).toEqual(new Date('2026-07-05T12:00:00Z'));
    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.auto_accepted',
      expect.objectContaining({
        correlationId: 'eng-1:auto_accepted',
        engagementId: 'eng-1',
        recipientId: 'owner-1',
        expertProfileId: 'ep-1',
        clientCompanyName: 'Northwind Industrial',
        expertPartyLabel: 'CloudPeak Consulting',
        projectTitle: 'CPQ implementation',
        milestonesTotal: 4,
        requestedDate: '3 Jul',
        autoDate: '10 Jul',
        reviewDays: 7,
      })
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'engagement_accepted',
      expect.objectContaining({
        engagement_id: 'eng-1',
        acceptance_method: 'auto',
        days_in_review: 7,
        review_cycle: 1,
        distinct_id: 'system:auto-accept',
      })
    );
  });

  it('isolates a failing row — one bad accept never aborts the batch', async () => {
    mockListPending
      .mockResolvedValueOnce([engRow({ id: 'bad' }), engRow({ id: 'good' })])
      .mockResolvedValueOnce([]);
    mockAccept
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(
        engRow({ status: 'completed', acceptedAt: new Date('2026-07-10T12:00:00Z') })
      );
    mockFindWithMilestones.mockResolvedValue(hydrated({ id: 'good' }));
    mockFindOwner.mockResolvedValue({ id: 'owner-1' });

    const result = await runDeliveryReviewSweep(new Date('2026-07-10T12:00:00Z'));

    expect(result.accepted).toBe(1); // only the good row counted
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('publishes with recipientId undefined when the client company has no live owner', async () => {
    mockListPending.mockResolvedValueOnce([engRow()]).mockResolvedValueOnce([]);
    mockAccept.mockResolvedValue(
      engRow({ status: 'completed', acceptedAt: new Date('2026-07-10T12:00:00Z') })
    );
    mockFindWithMilestones.mockResolvedValue(hydrated());
    mockFindOwner.mockRejectedValue(new Error('No owner found')); // retainer / owner-miss

    const result = await runDeliveryReviewSweep(new Date('2026-07-10T12:00:00Z'));

    expect(result.accepted).toBe(1); // expert + admins still notified
    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.auto_accepted',
      expect.objectContaining({ recipientId: undefined })
    );
  });
});

describe('runDeliveryReviewSweep — reminder pass', () => {
  it('sends the T-2 reminder for an in-window engagement with a pluralised daysLeft', async () => {
    mockListPending
      .mockResolvedValueOnce([]) // nothing past the auto-accept window
      .mockResolvedValueOnce([engRow({ id: 'eng-2', completionRequestedAt: REQUESTED_07_06 })]);
    mockFindWithMilestones.mockResolvedValue(hydrated({ id: 'eng-2' }));
    mockFindOwner.mockResolvedValue({ id: 'owner-2' });

    const now = new Date('2026-07-11T12:00:00Z'); // autoAt 07-13 → 2 days left
    const result = await runDeliveryReviewSweep(now);

    expect(result).toEqual({ accepted: 0, reminded: 1 });
    expect(mockAccept).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.review_reminder',
      expect.objectContaining({
        correlationId: `eng-2:review_reminder:${REQUESTED_07_06.getTime()}`,
        engagementId: 'eng-2',
        recipientId: 'owner-2',
        projectTitle: 'CPQ implementation',
        requestedDate: '6 Jul',
        autoDate: '13 Jul',
        daysLeft: 2,
      })
    );
    expect(mockTrackServer).toHaveBeenCalledWith(
      'engagement_review_reminder_sent',
      expect.objectContaining({ engagement_id: 'eng-2', distinct_id: 'owner-2' })
    );
  });

  it('skips the reminder (no send, not counted) when there is no client owner', async () => {
    mockListPending
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([engRow({ id: 'eng-3', completionRequestedAt: REQUESTED_07_06 })]);
    mockFindWithMilestones.mockResolvedValue(hydrated({ id: 'eng-3' }));
    mockFindOwner.mockRejectedValue(new Error('No owner found'));

    const result = await runDeliveryReviewSweep(new Date('2026-07-11T12:00:00Z'));

    expect(result.reminded).toBe(0);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('uses the independent expert’s own name as the party label (freelancer path)', async () => {
    mockListPending
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([engRow({ id: 'eng-4', completionRequestedAt: REQUESTED_07_06 })]);
    mockFindWithMilestones.mockResolvedValue(
      hydrated({
        id: 'eng-4',
        expertProfile: {
          id: 'ep-4',
          type: 'freelancer',
          agencyId: null,
          headline: null,
          user: { id: 'u-ex', firstName: 'Priya', lastName: 'Sharma', avatarUrl: null },
          agency: null,
        },
      })
    );
    mockFindOwner.mockResolvedValue({ id: 'owner-4' });

    await runDeliveryReviewSweep(new Date('2026-07-11T12:00:00Z'));

    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.review_reminder',
      expect.objectContaining({ expertPartyLabel: 'Priya Sharma' })
    );
  });

  it('does NOT remind a lingering overdue row past the auto-accept deadline (lower-bounded window)', async () => {
    // A row whose accept FAILED and now lingers well past T-7. The reminder query still
    // returns it (<= now-5d), but the lower bound (> now-7d) excludes it, so it never
    // gets a past-dated "1 day to go" reminder — it's retried by the accept pass instead.
    const overdue = engRow({
      id: 'eng-overdue',
      completionRequestedAt: new Date('2026-06-01T00:00:00Z'),
    });
    mockListPending
      .mockResolvedValueOnce([overdue]) // accept pass finds it (>= 7d)…
      .mockResolvedValueOnce([overdue]); // …reminder query returns it too (<= now-5d)
    mockAccept.mockRejectedValue(new Error('boom')); // …but the accept fails, so it lingers pending
    mockFindWithMilestones.mockResolvedValue(hydrated({ id: 'eng-overdue' }));
    mockFindOwner.mockResolvedValue({ id: 'owner-x' });

    const result = await runDeliveryReviewSweep(new Date('2026-07-11T12:00:00Z'));

    expect(result).toEqual({ accepted: 0, reminded: 0 });
    expect(mockPublish).not.toHaveBeenCalledWith('engagement.review_reminder', expect.anything());
  });
});

describe('config knobs', () => {
  it('exposes the T-2 lead and the hourly cron cadence', () => {
    expect(REVIEW_REMINDER_LEAD_DAYS).toBe(2);
    expect(DELIVERY_REVIEW_SWEEP_CRON).toBe('0 * * * *');
  });
});
