import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────
const {
  mockListAccepted,
  mockListClosed,
  mockListClientUserIds,
  mockFindOwnerUserId,
  mockFindCompany,
  mockFindProfile,
  mockFindUser,
  mockGetAgencySummary,
  mockFilterUnrated,
  mockCreateToken,
  mockPublish,
  mockTrackServer,
} = vi.hoisted(() => ({
  mockListAccepted: vi.fn(),
  mockListClosed: vi.fn(),
  mockListClientUserIds: vi.fn(),
  mockFindOwnerUserId: vi.fn(),
  mockFindCompany: vi.fn(),
  mockFindProfile: vi.fn(),
  mockFindUser: vi.fn(),
  mockGetAgencySummary: vi.fn(),
  mockFilterUnrated: vi.fn(),
  mockCreateToken: vi.fn(),
  mockPublish: vi.fn(),
  mockTrackServer: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: { listAcceptedBetween: mockListAccepted },
  caseEngagementsRepository: { listClosedBetween: mockListClosed },
  meetingPresenceRepository: { listClientUserIdsForEngagement: mockListClientUserIds },
  companiesRepository: {
    findOwnerUserIdByCompanyId: mockFindOwnerUserId,
    findById: mockFindCompany,
  },
  expertsRepository: { findProfileById: mockFindProfile },
  usersRepository: { findById: mockFindUser },
  agenciesRepository: { getSummaryById: mockGetAgencySummary },
  reviewsRepository: { filterUnratedReviewers: mockFilterUnrated },
  reviewInviteTokensRepository: { create: mockCreateToken },
}));

// `@balo/shared/reviews` and `@balo/shared/parties` are PURE — use the real band math and
// the real BAL-329 party-label rule (no mock). The band math is the thing under test.

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  REVIEW_SERVER_EVENTS: {
    SUBMITTED: 'review_submitted',
    UPDATED: 'review_updated',
    NUDGE_SENT: 'review_nudge_sent',
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

import { createHash } from 'node:crypto';
import type { RatingNudgeCandidate } from '@balo/db';
import { REVIEW_NUDGE_WINDOW_MS, REVIEW_NUDGE_STEPS } from '@balo/shared/reviews';
import { runReviewNudgeSweep, REVIEW_NUDGE_SWEEP_CRON } from './review-nudge-sweep.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A fixed wall clock so every band is deterministic. */
const NOW = new Date('2026-08-10T12:00:00Z');

const ENGAGEMENT_ID = 'eng-1';
const COMPANY_ID = 'co-1';
const EXPERT_PROFILE_ID = 'ep-1';
const OWNER_ID = 'owner-1';

function candidate(over: Partial<RatingNudgeCandidate> = {}): RatingNudgeCandidate {
  return {
    engagementId: ENGAGEMENT_ID,
    engagementKind: 'project',
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    anchorAt: new Date(NOW.getTime() - 24 * HOUR_MS),
    title: 'CPQ implementation',
    ...over,
  };
}

/**
 * Emulate the repository's HALF-OPEN `(after, until]` band predicate over a fixture set,
 * so the "no double-count across ticks" test exercises the real coupling between the
 * band width and the cron period rather than a hand-fed answer.
 */
function bandFiltered(rows: RatingNudgeCandidate[]) {
  return async (after: Date, until: Date): Promise<RatingNudgeCandidate[]> =>
    rows.filter(
      (row) => row.anchorAt.getTime() > after.getTime() && row.anchorAt.getTime() <= until.getTime()
    );
}

/** Run one tick, capturing the per-row messages the job would write to its BullMQ log. */
async function sweepCapturingLog(now: Date = NOW): Promise<{ sent: number; messages: string[] }> {
  const messages: string[] = [];
  const { sent } = await runReviewNudgeSweep(now, (m) => messages.push(m));
  return { sent, messages };
}

/** Nothing at all happened: no token minted, no event published, nobody emailed. */
function expectNoNudge(result: { sent: number }): void {
  expect(result).toEqual({ sent: 0 });
  expect(mockPublish).not.toHaveBeenCalled();
  expect(mockCreateToken).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: both anchors empty unless a test overrides them.
  mockListAccepted.mockResolvedValue([]);
  mockListClosed.mockResolvedValue([]);
  // No meetings writer exists yet, so participation is empty in production too.
  mockListClientUserIds.mockResolvedValue([]);
  mockFindOwnerUserId.mockResolvedValue(OWNER_ID);
  mockFindCompany.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
  mockFindProfile.mockResolvedValue({
    id: EXPERT_PROFILE_ID,
    type: 'agency',
    userId: 'u-ex',
    agencyId: 'ag-1',
  });
  mockFindUser.mockResolvedValue({ id: 'u-ex', firstName: 'Priya', lastName: 'Sharma' });
  mockGetAgencySummary.mockResolvedValue({ id: 'ag-1', name: 'CloudPeak Consulting' });
  // Nobody has rated: the set difference is the identity by default.
  mockFilterUnrated.mockImplementation(
    async (input: { candidateUserIds: string[] }) => input.candidateUserIds
  );
  mockCreateToken.mockResolvedValue({ id: 'tok-1' });
});

describe('review-nudge sweep — the band-width == cron-period invariant', () => {
  /**
   * ⚠⚠ THE LOAD-BEARING COUPLING. `REVIEW_NUDGE_WINDOW_MS` (the width of each candidate
   * band) and `REVIEW_NUDGE_SWEEP_CRON` (how often the sweep runs) are ONE knob wearing
   * two hats and MUST agree.
   *
   * WIDER band than period ⇒ the same engagement matches on consecutive ticks and the
   * same person is emailed repeatedly. Nothing downstream collapses those duplicates:
   * `apps/api/src/lib/queue.ts` sets `removeOnComplete: { count: 100 }` on ONE
   * `notification-events` queue shared by every event type, so a completed job's id is
   * evicted after 100 completions across ALL types and BullMQ jobId dedup cannot be
   * relied on. (This is precisely the confirmed defect in `auto-accept-sweep.ts`'s
   * reminder pass: a 48-hour band on an hourly cron. It is ticketed separately and is
   * NOT the model for this sweep.)
   *
   * NARROWER band than period ⇒ permanent, silent gaps: anchors falling between two
   * bands are never nudged at all.
   *
   * If you change the cron to daily, this test fails — and it should. Change both, or
   * neither.
   */
  it('couples the hourly cron to the one-hour band width', () => {
    expect(REVIEW_NUDGE_SWEEP_CRON).toBe('0 * * * *');
    expect(REVIEW_NUDGE_WINDOW_MS).toBe(HOUR_MS);
    expect(REVIEW_NUDGE_WINDOW_MS).toBe(3_600_000);
  });

  it('exposes exactly two cadence steps (+24h / +7d) — there is no step 3', () => {
    expect(REVIEW_NUDGE_STEPS.map((s) => s.step)).toEqual([1, 2]);
    expect(REVIEW_NUDGE_STEPS.map((s) => s.ageMs)).toEqual([24 * HOUR_MS, 7 * DAY_MS]);
  });
});

describe('review-nudge sweep — D5: both anchors, every tick', () => {
  /**
   * ⚠ THE CASE READER RETURNS `[]` TODAY — `caseEngagementsRepository.close()` has zero
   * production callers, so nothing stamps `closed_at` yet. This test exists so a future
   * "it always returns empty, let's drop the call" cannot land: the case anchor
   * self-activates with ZERO code change the moment BAL-420/BAL-421 ship.
   */
  it('queries listAcceptedBetween AND listClosedBetween for BOTH steps with identical bounds', async () => {
    await runReviewNudgeSweep(NOW);

    expect(mockListAccepted).toHaveBeenCalledTimes(2);
    expect(mockListClosed).toHaveBeenCalledTimes(2);

    // Step 1: anchor age ∈ [24h, 25h)
    const step1After = new Date(NOW.getTime() - 25 * HOUR_MS);
    const step1Until = new Date(NOW.getTime() - 24 * HOUR_MS);
    // Step 2: anchor age ∈ [168h, 169h)
    const step2After = new Date(NOW.getTime() - 7 * DAY_MS - HOUR_MS);
    const step2Until = new Date(NOW.getTime() - 7 * DAY_MS);

    expect(mockListAccepted.mock.calls[0]).toEqual([step1After, step1Until]);
    expect(mockListClosed.mock.calls[0]).toEqual([step1After, step1Until]);
    expect(mockListAccepted.mock.calls[1]).toEqual([step2After, step2Until]);
    expect(mockListClosed.mock.calls[1]).toEqual([step2After, step2Until]);
  });

  it('passes a band exactly REVIEW_NUDGE_WINDOW_MS wide to every anchor query', async () => {
    await runReviewNudgeSweep(NOW);

    for (const [after, until] of [...mockListAccepted.mock.calls, ...mockListClosed.mock.calls]) {
      expect((until as Date).getTime() - (after as Date).getTime()).toBe(REVIEW_NUDGE_WINDOW_MS);
    }
  });

  it('nudges a CASE candidate through the same path as a project one', async () => {
    mockListClosed.mockImplementation(
      bandFiltered([
        candidate({
          engagementId: 'case-1',
          engagementKind: 'case',
          anchorAt: new Date(NOW.getTime() - 24 * HOUR_MS),
          title: 'Flow debugging',
        }),
      ])
    );

    const result = await runReviewNudgeSweep(NOW);

    expect(result).toEqual({ sent: 1 });
    expect(mockPublish).toHaveBeenCalledWith(
      'review.reminder',
      expect.objectContaining({
        engagementId: 'case-1',
        engagementKind: 'case',
        engagementTitle: 'Flow debugging',
      })
    );
  });

  /**
   * The +7d copy states WHY the case closed, so the reason has to travel with the
   * candidate. Without it the nudge asserts "things went quiet" over a case the client
   * deliberately resolved — seven days after the close email said "wrapped up".
   */
  it.each(['resolved', 'auto_inactive'] as const)(
    "threads a case candidate's %s close reason into the payload",
    async (closeReason) => {
      mockListClosed.mockImplementation(
        bandFiltered([candidate({ engagementId: 'case-1', engagementKind: 'case', closeReason })])
      );

      await runReviewNudgeSweep(NOW);

      expect(mockPublish).toHaveBeenCalledWith(
        'review.reminder',
        expect.objectContaining({ engagementKind: 'case', closeReason })
      );
    }
  );

  it('a PROJECT candidate carries no close reason at all', async () => {
    mockListAccepted.mockImplementation(bandFiltered([candidate()]));

    await runReviewNudgeSweep(NOW);

    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.closeReason).toBeUndefined();
  });

  it('an empty case reader is not an error and does not disturb the project publishes', async () => {
    mockListAccepted.mockImplementation(bandFiltered([candidate()]));
    mockListClosed.mockResolvedValue([]);

    const result = await runReviewNudgeSweep(NOW);

    expect(result).toEqual({ sent: 1 });
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});

describe('review-nudge sweep — publish payload', () => {
  beforeEach(() => {
    mockListAccepted.mockImplementation(bandFiltered([candidate()]));
  });

  it('publishes review.reminder with the per-(engagement, reviewer, step) correlationId', async () => {
    const result = await runReviewNudgeSweep(NOW);

    expect(result).toEqual({ sent: 1 });
    expect(mockPublish).toHaveBeenCalledWith('review.reminder', {
      correlationId: `${ENGAGEMENT_ID}:${OWNER_ID}:review_nudge:1`,
      engagementId: ENGAGEMENT_ID,
      userId: OWNER_ID,
      reviewToken: expect.any(String),
      cadenceStep: 1,
      engagementKind: 'project',
      engagementTitle: 'CPQ implementation',
      expertPartyLabel: 'CloudPeak Consulting',
      clientCompanyName: 'Northwind Industrial',
      anchorDate: '9 Aug',
    });
  });

  it('names the INDEPENDENT expert by their own name (BAL-329 party rule)', async () => {
    mockFindProfile.mockResolvedValue({
      id: EXPERT_PROFILE_ID,
      type: 'freelancer',
      userId: 'u-ex',
      agencyId: null,
    });

    await runReviewNudgeSweep(NOW);

    expect(mockGetAgencySummary).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith(
      'review.reminder',
      expect.objectContaining({ expertPartyLabel: 'Priya Sharma' })
    );
  });

  it('mints the token BEFORE publishing, and the RAW token — never its hash — rides the payload', async () => {
    await runReviewNudgeSweep(NOW);

    expect(mockCreateToken).toHaveBeenCalledTimes(1);
    const mintCall = mockCreateToken.mock.calls[0]?.[0] as {
      engagementId: string;
      reviewerUserId: string;
      tokenHash: string;
    };
    const published = mockPublish.mock.calls[0]?.[1] as { reviewToken: string };

    expect(mintCall.engagementId).toBe(ENGAGEMENT_ID);
    expect(mintCall.reviewerUserId).toBe(OWNER_ID);
    // 32 random bytes → 43 base64url characters, and the STORED value is its SHA-256 hex.
    expect(published.reviewToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintCall.tokenHash).not.toBe(published.reviewToken);
    expect(mintCall.tokenHash).toBe(
      createHash('sha256').update(published.reviewToken).digest('hex')
    );
    // Ordering: the mint resolves before the publish is attempted.
    const [mintOrder] = mockCreateToken.mock.invocationCallOrder;
    const [publishOrder] = mockPublish.mock.invocationCallOrder;
    expect(mintOrder).toBeLessThan(publishOrder);
  });

  it('tags _sent with the cadence step, the engagement kind and the reviewer — never the token', async () => {
    await runReviewNudgeSweep(NOW);

    expect(mockTrackServer).toHaveBeenCalledWith('review_nudge_sent', {
      cadence_step: 1,
      engagement_kind: 'project',
      distinct_id: OWNER_ID,
    });
    const properties = JSON.stringify(mockTrackServer.mock.calls[0]?.[1]);
    const published = mockPublish.mock.calls[0]?.[1] as { reviewToken: string };
    expect(properties).not.toContain(published.reviewToken);
  });
});

describe('review-nudge sweep — recipients', () => {
  beforeEach(() => {
    mockListAccepted.mockImplementation(bandFiltered([candidate()]));
  });

  /**
   * ⚠ ONE PUBLISH PER REVIEWER, NEVER A FAN-OUT RECIPIENT. `reviewToken` is per-person
   * and the dispatcher shares ONE payload across a fan-out, so a fan-out would put one
   * person's magic link in everyone else's inbox.
   */
  it('publishes once per unrated reviewer, with a DISTINCT token and correlationId each', async () => {
    mockListClientUserIds.mockResolvedValue(['member-a', 'member-b']);
    mockFindOwnerUserId.mockResolvedValue(undefined);

    const result = await runReviewNudgeSweep(NOW);

    expect(result).toEqual({ sent: 2 });
    expect(mockPublish).toHaveBeenCalledTimes(2);

    const payloads = mockPublish.mock.calls.map(
      (call) => call[1] as { userId: string; reviewToken: string; correlationId: string }
    );
    expect(payloads.map((p) => p.userId)).toEqual(['member-a', 'member-b']);
    expect(new Set(payloads.map((p) => p.reviewToken)).size).toBe(2);
    expect(new Set(payloads.map((p) => p.correlationId)).size).toBe(2);
  });

  /**
   * ⚠ THE COMPANY OWNER IS UNIONED IN ON EVERY TICK — NOT a fallback for an empty
   * participant set. The module doc used to call it one; it never was, and the guard that
   * word implies would be a REGRESSION, not a tidy-up: the moment BAL-129/134 record a
   * single meeting attendee, a conditional union would silently stop asking the person
   * accountable for the engagement. This test pins the union so that "fix" cannot land
   * quietly — today it is the only thing standing between the doc and the code.
   */
  it('ALWAYS asks the company owner, even when participants were recorded', async () => {
    mockListClientUserIds.mockResolvedValue(['member-a', 'member-b']);

    const result = await runReviewNudgeSweep(NOW);

    expect(result).toEqual({ sent: 3 });
    expect(mockFilterUnrated).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      candidateUserIds: ['member-a', 'member-b', OWNER_ID],
    });
    const recipients = mockPublish.mock.calls.map((call) => (call[1] as { userId: string }).userId);
    expect(recipients).toContain(OWNER_ID);
  });

  it('de-duplicates a participant who is also the company owner', async () => {
    mockListClientUserIds.mockResolvedValue([OWNER_ID]);

    const result = await runReviewNudgeSweep(NOW);

    expect(result).toEqual({ sent: 1 });
    expect(mockFilterUnrated).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      candidateUserIds: [OWNER_ID],
    });
  });

  it('skips (does not throw) when there is no participant and no live company owner', async () => {
    mockListClientUserIds.mockResolvedValue([]);
    mockFindOwnerUserId.mockResolvedValue(undefined);

    expectNoNudge(await runReviewNudgeSweep(NOW));
  });

  /**
   * The AC "nudges stop once a review exists" is satisfied by the query no longer
   * matching — there is NO cancellation code and no scheduled per-engagement job to
   * cancel. Suppression happens twice: in SQL at engagement level (the readers' NOT
   * EXISTS) and here at reviewer level, at SEND time.
   */
  it('suppresses at send time when the reviewer has already rated — no cancellation path', async () => {
    mockFilterUnrated.mockResolvedValue([]);

    expectNoNudge(await runReviewNudgeSweep(NOW));
  });
});

describe('review-nudge sweep — isolation', () => {
  it('one failing recipient never costs the others their nudge; `sent` counts successes only', async () => {
    mockListAccepted.mockImplementation(bandFiltered([candidate()]));
    mockListClientUserIds.mockResolvedValue(['bad', 'good']);
    mockFindOwnerUserId.mockResolvedValue(undefined);
    mockPublish.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);

    const { sent, messages } = await sweepCapturingLog();

    expect(sent).toBe(1);
    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockTrackServer).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledWith(
      'review_nudge_sent',
      expect.objectContaining({ distinct_id: 'good' })
    );
    expect(messages.join('\n')).toContain('reviewer bad');
  });

  it('one failing engagement never aborts the batch', async () => {
    mockListAccepted.mockImplementation(
      bandFiltered([candidate({ engagementId: 'bad' }), candidate({ engagementId: 'good' })])
    );
    mockListClientUserIds.mockRejectedValueOnce(new Error('boom'));

    const { sent, messages } = await sweepCapturingLog();

    expect(sent).toBe(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'review.reminder',
      expect.objectContaining({ engagementId: 'good' })
    );
    expect(messages.join('\n')).toContain('engagement bad');
  });

  it('skips an engagement whose display fields cannot be resolved, rather than emailing a placeholder', async () => {
    mockListAccepted.mockImplementation(bandFiltered([candidate()]));
    mockFindCompany.mockResolvedValue(undefined);

    const { sent, messages } = await sweepCapturingLog();

    expectNoNudge({ sent });
    expect(messages.join('\n')).toContain('display fields unresolved');
  });
});

describe('review-nudge sweep — once per step, and never a third time', () => {
  /**
   * THE DEFINITIVE ONCE-NESS TEST AT THE SWEEP LEVEL. A single anchor, swept HOURLY
   * across 30 days with the repository's real half-open band predicate emulated: the
   * engagement is nudged EXACTLY TWICE — once at step 1, once at step 2 — and never
   * again, for any tick, ever.
   *
   * ⚠ THIS IS THE ONLY PLACE THE HARD STOP CAN BE PROVEN (together with the band-math
   * unit tests in `@balo/shared/reviews`). `notification_log` CANNOT prove it:
   * `notifications.correlation_id` is `uuid NOT NULL` while this sweep writes the
   * composite string `${engagementId}:${userId}:review_nudge:${step}`, so the insert is
   * rejected `22P02` and swallowed by the log channel's own try/catch. These nudges will
   * never appear in that table.
   */
  it('nudges exactly twice across 30 days of hourly ticks — never a third time', async () => {
    const anchorAt = new Date('2026-08-01T09:17:00Z');
    mockListAccepted.mockImplementation(bandFiltered([candidate({ anchorAt })]));

    const steps: number[] = [];
    mockPublish.mockImplementation(async (_event: string, payload: { cadenceStep: number }) => {
      steps.push(payload.cadenceStep);
    });

    // Tick every hour, on the hour, for 30 days starting before the anchor.
    const firstTick = new Date('2026-08-01T00:00:00Z').getTime();
    for (let hour = 0; hour < 30 * 24; hour += 1) {
      await runReviewNudgeSweep(new Date(firstTick + hour * HOUR_MS));
    }

    expect(steps).toEqual([1, 2]);
  });

  it('does not double-count the same engagement on two consecutive ticks', async () => {
    const anchorAt = new Date(NOW.getTime() - 24 * HOUR_MS);
    mockListAccepted.mockImplementation(bandFiltered([candidate({ anchorAt })]));

    const first = await runReviewNudgeSweep(NOW);
    const second = await runReviewNudgeSweep(new Date(NOW.getTime() + HOUR_MS));

    expect(first.sent + second.sent).toBe(1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠ AN UNPUNCTUAL CRON IS THE NORMAL CASE, and the band math alone does not survive it.
   * BullMQ fires a repeatable job late under load, so the real tick sequence is not
   * 13:00 / 14:00 but 13:04 / 14:00 — and with a RAW `new Date()` those two ticks produce
   * step-1 bands `(…12:04, …13:04]` and `(…13:00, …14:00]`, which OVERLAP over four
   * minutes. Every anchor in that sliver was nudged TWICE: two magic-link tokens minted and
   * two `review_nudge_sent` events. (The email itself survived only by luck — the
   * `correlationId` carries no tick, so the second publish dedups against the first.)
   *
   * `runReviewNudgeSweep` floors the tick onto the hourly grid, so both ticks agree on
   * which hour they are sweeping. Both cadence steps are exercised here because the fault
   * was in the shared tick, not in either band.
   */
  it('a LATE tick (13:04) and the next on-time tick (14:00) nudge each step exactly once', async () => {
    const lateTick = new Date('2026-08-10T13:04:00Z');
    const onTimeTick = new Date('2026-08-10T14:00:00Z');
    mockListAccepted.mockImplementation(
      bandFiltered([
        // 24h + 2min before the on-time tick — inside the raw ticks' step-1 overlap.
        candidate({ engagementId: 'eng-step1', anchorAt: new Date('2026-08-09T13:02:00Z') }),
        // 7d + 2min before it — inside the raw ticks' step-2 overlap.
        candidate({ engagementId: 'eng-step2', anchorAt: new Date('2026-08-03T13:02:00Z') }),
      ])
    );

    const late = await runReviewNudgeSweep(lateTick);
    const onTime = await runReviewNudgeSweep(onTimeTick);

    expect(late.sent + onTime.sent).toBe(2);
    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockCreateToken).toHaveBeenCalledTimes(2);
    expect(mockTrackServer).toHaveBeenCalledTimes(2);

    const nudged = mockPublish.mock.calls.map(
      (call) => call[1] as { engagementId: string; cadenceStep: number }
    );
    expect(nudged.map((p) => [p.engagementId, p.cadenceStep])).toEqual([
      ['eng-step1', 1],
      ['eng-step2', 2],
    ]);
  });

  /**
   * The other half of the same property: quantising must not COST a nudge. A tick that runs
   * late within its own hour still sweeps that hour's band — it does not skip forward.
   */
  it('a tick that is merely late still sweeps its own hour, rather than skipping it', async () => {
    const anchorAt = new Date('2026-08-09T12:30:00Z'); // inside the 13:00 tick's step-1 band
    mockListAccepted.mockImplementation(bandFiltered([candidate({ anchorAt })]));

    const result = await runReviewNudgeSweep(new Date('2026-08-10T13:47:11Z'));

    expect(result).toEqual({ sent: 1 });
    expect(mockPublish).toHaveBeenCalledWith(
      'review.reminder',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, cadenceStep: 1 })
    );
  });
});
