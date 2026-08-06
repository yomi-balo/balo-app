import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────
const {
  mockListPending,
  mockAccept,
  mockFindWithMilestones,
  mockFindOwner,
  mockCountAudit,
  mockFindLiveReview,
  mockCreateReviewToken,
  mockPublish,
  mockTrackServer,
} = vi.hoisted(() => ({
  mockListPending: vi.fn(),
  mockAccept: vi.fn(),
  mockFindWithMilestones: vi.fn(),
  mockFindOwner: vi.fn(),
  mockCountAudit: vi.fn(),
  mockFindLiveReview: vi.fn(),
  mockCreateReviewToken: vi.fn(),
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
  // BAL-390: `autoAcceptOne` now fuses the star-rating ask into the auto-accept email,
  // and the mint helper (`../lib/review-token.js`) imports the token repository from
  // this same mocked module — both exports are REQUIRED here or the named import throws.
  reviewsRepository: { findLive: mockFindLiveReview },
  reviewInviteTokensRepository: { create: mockCreateReviewToken },
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
  // BAL-390 defaults: the client recipient has not rated yet, so a token is minted.
  mockFindLiveReview.mockResolvedValue(undefined);
  mockCreateReviewToken.mockResolvedValue({ id: 'tok-1' });
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

describe('runDeliveryReviewSweep — BAL-390 fused rating ask (auto-accept pass ONLY)', () => {
  function pendingRow() {
    mockListPending.mockResolvedValueOnce([engRow()]).mockResolvedValueOnce([]);
    mockAccept.mockResolvedValue(
      engRow({ status: 'completed', acceptedAt: new Date('2026-07-10T12:00:00Z') })
    );
    mockFindWithMilestones.mockResolvedValue(hydrated());
    mockFindOwner.mockResolvedValue({ id: 'owner-1' });
  }

  it('mints a token for the client recipient and threads the RAW value onto the payload', async () => {
    pendingRow();

    await runDeliveryReviewSweep(new Date('2026-07-10T12:00:00Z'));

    expect(mockFindLiveReview).toHaveBeenCalledWith('eng-1', 'owner-1', 'ep-1');
    expect(mockCreateReviewToken).toHaveBeenCalledTimes(1);
    const mint = mockCreateReviewToken.mock.calls[0]?.[0] as {
      engagementId: string;
      reviewerUserId: string;
      tokenHash: string;
    };
    const payload = mockPublish.mock.calls[0]?.[1] as { reviewToken?: string };
    expect(mint.engagementId).toBe('eng-1');
    expect(mint.reviewerUserId).toBe('owner-1');
    // 32 random bytes → 43 base64url chars; the STORED value is its SHA-256 hex, not this.
    expect(payload.reviewToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mint.tokenHash).not.toBe(payload.reviewToken);
  });

  it('omits reviewToken when the recipient has ALREADY rated this expert', async () => {
    pendingRow();
    mockFindLiveReview.mockResolvedValue({ id: 'rev-1', rating: 5 });

    const result = await runDeliveryReviewSweep(new Date('2026-07-10T12:00:00Z'));

    expect(result.accepted).toBe(1);
    expect(mockCreateReviewToken).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.auto_accepted',
      expect.objectContaining({ reviewToken: undefined })
    );
  });

  /**
   * ⚠ NEVER FAILS THE ACCEPT, AND NEVER SWALLOWS THE CAUSE. This catch used to be a bare
   * `catch { return undefined; }` with no log at all, so a mint that failed for every row —
   * a bad DB credential, a dropped column — was indistinguishable from "everyone had
   * already rated": silently, nobody got a star row. CLAUDE.md forbids exactly that. The
   * sweep's own per-row `log` callback is threaded down to report it.
   *
   * WARN, NOT ERROR: the ask itself is not lost, because `review-nudge-sweep.ts` re-mints a
   * fresh token for this same owner at +24h and again at +7d.
   */
  it('omits reviewToken (never fails the accept) when the mint throws — and reports it', async () => {
    pendingRow();
    mockCreateReviewToken.mockRejectedValue(new Error('db down'));

    const messages: string[] = [];
    const result = await runDeliveryReviewSweep(new Date('2026-07-10T12:00:00Z'), (message) =>
      messages.push(message)
    );

    expect(result.accepted).toBe(1); // the money path (expert + admin notify) still ran
    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.auto_accepted',
      expect.objectContaining({ reviewToken: undefined })
    );

    const logged = messages.join('\n');
    // Enough context to debug: which engagement, which reviewer, what actually failed.
    expect(logged).toContain('eng-1');
    expect(logged).toContain('owner-1');
    expect(logged).toContain('db down');
    // Framed as recoverable, not as a failed row — the nudge sweep re-mints.
    expect(logged).toMatch(/warning/i);
    // Never the raw token (43 base64url chars) nor its SHA-256 hex.
    expect(logged).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(logged).not.toMatch(/[a-f0-9]{64}/);
  });

  /**
   * The counterpart: the two NON-failure reasons a token is absent are ordinary outcomes,
   * not incidents. If they logged, a healthy sweep would cry wolf on every tick and the
   * genuine mint failure above would be lost in it.
   */
  it.each([
    [
      'the recipient has already rated',
      () => mockFindLiveReview.mockResolvedValue({ id: 'rev-1' }),
    ],
    [
      'there is no client recipient',
      () => mockFindOwner.mockRejectedValue(new Error('No owner found')),
    ],
  ])('stays quiet when %s — that is an outcome, not an incident', async (_name, arrange) => {
    pendingRow();
    arrange();

    const messages: string[] = [];
    await runDeliveryReviewSweep(new Date('2026-07-10T12:00:00Z'), (message) =>
      messages.push(message)
    );

    expect(messages).toEqual([]);
  });

  it('omits reviewToken when there is no client recipient (retainer / owner-miss)', async () => {
    pendingRow();
    mockFindOwner.mockRejectedValue(new Error('No owner found'));

    await runDeliveryReviewSweep(new Date('2026-07-10T12:00:00Z'));

    expect(mockFindLiveReview).not.toHaveBeenCalled();
    expect(mockCreateReviewToken).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.auto_accepted',
      expect.objectContaining({ reviewToken: undefined })
    );
  });

  /**
   * ⚠ THE BOUNDARY, ENCODED AS A TEST. BAL-390 touched `autoAcceptOne` and NOTHING ELSE
   * in this file. The T-2 reminder pass (`remindOne` + `runDeliveryReviewSweep`'s second
   * pass) is CONFIRMED BROKEN — a `(now−7d, now−5d]`, i.e. 48-hour, band against an
   * hourly cron, leaning on BullMQ jobId dedup that the shared `notification-events`
   * queue's `removeOnComplete: { count: 100 }` cannot supply. It is ticketed separately
   * and was deliberately NOT fixed, NOT copied, and NOT used as precedent here. If a
   * future change makes the reminder pass mint review tokens, this fails.
   */
  it('leaves the T-2 reminder pass completely untouched — it mints nothing', async () => {
    mockListPending
      .mockResolvedValueOnce([]) // nothing to auto-accept
      .mockResolvedValueOnce([engRow({ id: 'eng-2', completionRequestedAt: REQUESTED_07_06 })]);
    mockFindWithMilestones.mockResolvedValue(hydrated({ id: 'eng-2' }));
    mockFindOwner.mockResolvedValue({ id: 'owner-2' });

    const result = await runDeliveryReviewSweep(new Date('2026-07-11T12:00:00Z'));

    expect(result).toEqual({ accepted: 0, reminded: 1 });
    expect(mockFindLiveReview).not.toHaveBeenCalled();
    expect(mockCreateReviewToken).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(
      'engagement.review_reminder',
      expect.not.objectContaining({ reviewToken: expect.anything() })
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
