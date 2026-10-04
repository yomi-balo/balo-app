import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-572 — unit coverage for the sweep body (`runCaseInactivitySweep`), exported precisely so
 * it can be exercised without a Redis-backed Worker.
 *
 * What is REAL (pure, unmocked): `isCaseInactive` / `CASE_INACTIVITY_DAYS` /
 * `buildCaseClosedPayload` / `summariseCaseCloseAnchors` (`@balo/shared/engagements`) — the
 * inactivity rule and the payload assembly are the thing under test, not a fixture to
 * hand-answer. `MEETING_TOKEN_TTL_AFTER_END_MS` (`../services/meetings/meeting-liveness.js`),
 * `LIFECYCLE_LOOKBACK_MS` (`./meeting-lifecycle-sweep.js`) and `MAX_AVAILABILITY_WINDOW_DAYS`
 * (`@balo/shared/availability`) are also real constants.
 *
 * What is MOCKED: `@balo/db` (every repository call), the logger, `@balo/analytics/server`,
 * the notification publisher, and BullMQ's `Worker` (a real one would try a live Redis
 * connection and hang the suite).
 */

const {
  mockListOpenCreatedBefore,
  mockClose,
  mockConsultationTimestamps,
  mockLatestChatActivity,
  mockLatestStatusChange,
  mockEngagementIdsWithLiveCaseMeeting,
  mockListMeetingsForContext,
  mockFindOwnerUserId,
  mockFindNameById,
  mockFindDisplayProfileById,
  mockFindDisplayById,
  mockGetAgencySummary,
  mockPublish,
  mockTrackServer,
  mockLog,
  mockLoggerContexts,
  mockQueueAdd,
  mockMintReviewInviteToken,
} = vi.hoisted(() => ({
  mockListOpenCreatedBefore: vi.fn(),
  mockClose: vi.fn(),
  mockConsultationTimestamps: vi.fn(),
  mockLatestChatActivity: vi.fn(),
  mockLatestStatusChange: vi.fn(),
  mockEngagementIdsWithLiveCaseMeeting: vi.fn(),
  mockListMeetingsForContext: vi.fn(),
  mockFindOwnerUserId: vi.fn(),
  mockFindNameById: vi.fn(),
  mockFindDisplayProfileById: vi.fn(),
  mockFindDisplayById: vi.fn(),
  mockGetAgencySummary: vi.fn(),
  mockPublish: vi.fn(),
  mockTrackServer: vi.fn(),
  /** ONE STABLE logger instance — every call site shares it, so `.mock.calls` is the whole story. */
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  /** Every `createLogger` context, in import order — survives `vi.clearAllMocks`. */
  mockLoggerContexts: [] as string[],
  mockQueueAdd: vi.fn(),
  /** Pinned NEVER called — see the "never mints a review token" test below. */
  mockMintReviewInviteToken: vi.fn(),
}));

// ⚠ `vi.hoisted` IS REQUIRED — `vi.mock` factories hoist above every top-level declaration, so
// a plain `class X extends Error {}` here would be in its TDZ when the factory runs.
const { CaseAlreadyClosedError } = vi.hoisted(() => {
  class AlreadyClosed extends Error {
    constructor(
      public readonly engagementId: string,
      public readonly closedAt: Date
    ) {
      super(`Case ${engagementId} was already closed at ${closedAt.toISOString()}`);
      this.name = 'CaseAlreadyClosedError';
    }
  }
  return { CaseAlreadyClosedError: AlreadyClosed };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: (context: string) => {
    mockLoggerContexts.push(context);
    return mockLog;
  },
}));

vi.mock('@balo/db', () => ({
  CaseAlreadyClosedError,
  caseEngagementsRepository: {
    listOpenCreatedBefore: mockListOpenCreatedBefore,
    close: mockClose,
  },
  meetingContextsRepository: {
    consultationTimestampsForEngagements: mockConsultationTimestamps,
    engagementIdsWithLiveCaseMeeting: mockEngagementIdsWithLiveCaseMeeting,
    listMeetingsForContext: mockListMeetingsForContext,
  },
  conversationsRepository: {
    latestChatActivityAtForEngagements: mockLatestChatActivity,
  },
  actionItemsRepository: {
    latestStatusChangeAtForEngagements: mockLatestStatusChange,
  },
  companiesRepository: {
    findOwnerUserIdByCompanyId: mockFindOwnerUserId,
    findNameById: mockFindNameById,
  },
  expertsRepository: { findDisplayProfileById: mockFindDisplayProfileById },
  usersRepository: { findDisplayById: mockFindDisplayById },
  agenciesRepository: { getSummaryById: mockGetAgencySummary },
}));

vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  RECAP_SERVER_EVENTS: { CASE_RESOLVED: 'case_resolved' },
}));

vi.mock('../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));

vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn(() => ({ add: mockQueueAdd })) }));
vi.mock('bullmq', () => ({
  Worker: class MockWorker {},
}));
vi.mock('../lib/review-token.js', () => ({ mintReviewInviteToken: mockMintReviewInviteToken }));

import type { CaseEngagementRow } from '@balo/db';
import { MAX_AVAILABILITY_WINDOW_DAYS } from '@balo/shared/availability';
import { CASE_INACTIVITY_DAYS } from '@balo/shared/engagements';
import { MEETING_TOKEN_TTL_AFTER_END_MS } from '../services/meetings/meeting-liveness.js';
import { LIFECYCLE_LOOKBACK_MS } from './meeting-lifecycle-sweep.js';
import {
  runCaseInactivitySweep,
  registerCaseInactivitySweepCron,
  CASE_INACTIVITY_SWEEP_CRON,
  CANDIDATE_CHUNK_SIZE,
  MAX_CASE_CLOSES_PER_TICK,
  SYSTEM_DISTINCT_ID,
} from './case-inactivity-sweep.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-01T12:30:00Z');

/** A structural, PARTIAL `CaseEngagementRow` — only the fields the sweep actually reads. */
function caseRow(over: Partial<CaseEngagementRow> = {}): Partial<CaseEngagementRow> {
  return {
    id: 'eng-1',
    companyId: 'co-1',
    expertProfileId: 'ep-1',
    createdAt: new Date(NOW.getTime() - (CASE_INACTIVITY_DAYS + 1) * DAY_MS),
    title: 'Flow interview loop',
    closedAt: null,
    ...over,
  };
}

type ConsultationEntry = {
  lastCompletedConsultationAt: Date | null;
  nextScheduledConsultationAt: Date | null;
  lastSchedulingActivityAt: Date | null;
};

/** An all-null seam entry — no completed consultation, nothing upcoming, no scheduling action. */
const NO_SEAM_ACTIVITY: ConsultationEntry = {
  lastCompletedConsultationAt: null,
  nextScheduledConsultationAt: null,
  lastSchedulingActivityAt: null,
};

/** Every requested id answers "never consulted" — inactive by anchors, unless overridden. */
function neverConsultedMap(ids: readonly string[]): Map<string, ConsultationEntry> {
  return new Map(ids.map((id) => [id, { ...NO_SEAM_ACTIVITY }]));
}

/**
 * Every requested id answers `null` — the chat read's (and the action-item read's) legitimate
 * "no activity".
 */
function noChatMap(ids: readonly string[]): Map<string, Date | null> {
  return new Map(ids.map((id) => [id, null]));
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** One candidate whose seam entry and chat value are both supplied by the test. */
function oneCase(seam: Partial<ConsultationEntry>, lastChatActivityAt: Date | null): void {
  mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1', createdAt: daysAgo(90) })]);
  mockConsultationTimestamps.mockImplementation(
    async (ids: string[]) => new Map(ids.map((id) => [id, { ...NO_SEAM_ACTIVITY, ...seam }]))
  );
  mockLatestChatActivity.mockImplementation(
    async (ids: string[]) => new Map(ids.map((id) => [id, lastChatActivityAt]))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListOpenCreatedBefore.mockResolvedValue([]);
  mockConsultationTimestamps.mockImplementation(async (ids: string[]) => neverConsultedMap(ids));
  mockLatestChatActivity.mockImplementation(async (ids: string[]) => noChatMap(ids));
  mockLatestStatusChange.mockImplementation(async (ids: string[]) => noChatMap(ids));
  mockEngagementIdsWithLiveCaseMeeting.mockResolvedValue(new Set());
  mockListMeetingsForContext.mockResolvedValue([]);
  mockFindOwnerUserId.mockResolvedValue('owner-1');
  mockFindNameById.mockResolvedValue({ id: 'co-1', name: 'Northwind Industrial' });
  mockFindDisplayProfileById.mockResolvedValue({
    id: 'ep-1',
    userId: 'u-ex',
    agencyId: null,
    type: 'freelancer',
  });
  mockFindDisplayById.mockResolvedValue({ id: 'u-ex', firstName: 'Amara', lastName: 'Okafor' });
  mockGetAgencySummary.mockResolvedValue(undefined);
  mockPublish.mockResolvedValue(undefined);
  mockClose.mockImplementation(async (input: { engagementId: string }) =>
    caseRow({ id: input.engagementId, closedAt: NOW })
  );
});

describe('case-inactivity sweep — module constants', () => {
  it('is hourly, offset off the :00 sweeps', () => {
    expect(CASE_INACTIVITY_SWEEP_CRON).toBe('30 * * * *');
  });

  it('chunks candidate reads at 500, far under the postgres-js bind limit', () => {
    expect(CANDIDATE_CHUNK_SIZE).toBe(500);
  });

  it('caps closes per tick at 100', () => {
    expect(MAX_CASE_CLOSES_PER_TICK).toBe(100);
  });

  it('the system distinct id is stable and namespaced', () => {
    expect(SYSTEM_DISTINCT_ID).toBe('system:case-inactivity');
  });

  it('logs under the case-inactivity-sweep context the lost-notice runbook filters on', () => {
    expect(mockLoggerContexts).toContain('case-inactivity-sweep');
  });

  it('registers as a repeatable, hourly, on the case-inactivity-sweep queue', async () => {
    await registerCaseInactivitySweepCron();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { pattern: '30 * * * *' }, removeOnComplete: true }
    );
  });
});

describe('case-inactivity sweep — the live-meeting exclusion floor', () => {
  it('TTL is at least LIFECYCLE_LOOKBACK_MS, so every meeting the lifecycle sweep still manages is covered', () => {
    expect(MEETING_TOKEN_TTL_AFTER_END_MS).toBeGreaterThanOrEqual(LIFECYCLE_LOOKBACK_MS);
  });

  /**
   * A booking made L days ahead and then missed holds its case for 30 − L days past the call's
   * start (the booking's scheduling anchor is the only thing left once the call is neither
   * upcoming nor completed). Widening the booking grid past 30 days would let a missed far-ahead
   * booking close its case right after the call.
   */
  it('the booking grid stays shorter than the inactivity window, so a missed booking still holds its case', () => {
    expect(MAX_AVAILABILITY_WINDOW_DAYS).toBeLessThan(CASE_INACTIVITY_DAYS);
  });

  it('the exclusion floor is exactly now − MEETING_TOKEN_TTL_AFTER_END_MS', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow()]);

    await runCaseInactivitySweep(NOW);

    expect(mockEngagementIdsWithLiveCaseMeeting).toHaveBeenCalledWith(
      ['eng-1'],
      new Date(NOW.getTime() - MEETING_TOKEN_TTL_AFTER_END_MS)
    );
  });

  it('a held id is not closed and counts heldByLiveMeeting', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'held-1' })]);
    mockEngagementIdsWithLiveCaseMeeting.mockResolvedValue(new Set(['held-1']));

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(result.heldByLiveMeeting).toBe(1);
    expect(result.closed).toBe(0);
  });
});

describe('case-inactivity sweep — the core close', () => {
  it('closes an inactive candidate with exactly { engagementId, reason: "auto_inactive" }', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).toHaveBeenCalledWith({ engagementId: 'eng-1', reason: 'auto_inactive' });
    expect(result.closed).toBe(1);
  });

  it('leaves a case with an upcoming consultation open', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);
    mockConsultationTimestamps.mockResolvedValue(
      new Map([
        [
          'eng-1',
          {
            lastCompletedConsultationAt: null,
            nextScheduledConsultationAt: new Date(NOW.getTime() + DAY_MS),
            lastSchedulingActivityAt: null,
          },
        ],
      ])
    );

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
    expect(result.foundInactive).toBe(0);
  });

  it('an all-null seam entry and a null chat value, created 31 days before now, closes', async () => {
    const createdAt = new Date(NOW.getTime() - 31 * DAY_MS);
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1', createdAt })]);
    mockConsultationTimestamps.mockResolvedValue(
      new Map([
        [
          'eng-1',
          {
            lastCompletedConsultationAt: null,
            nextScheduledConsultationAt: null,
            lastSchedulingActivityAt: null,
          },
        ],
      ])
    );
    mockLatestChatActivity.mockResolvedValue(new Map([['eng-1', null]]));

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).toHaveBeenCalledWith({ engagementId: 'eng-1', reason: 'auto_inactive' });
    expect(result.closed).toBe(1);
    expect(mockLog.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Map miss')
    );
  });

  it('a seam-Map miss is skipped and warned, never defaulted', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'missing-1' })]);
    mockConsultationTimestamps.mockResolvedValue(new Map());

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
    expect(result.foundInactive).toBe(0);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      { engagementId: 'missing-1' },
      'Case inactivity sweep: seam Map miss — candidate skipped, anchors never defaulted'
    );
    expect(mockLog.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('chat-activity')
    );
  });

  it('a chat-activity Map miss is skipped and warned, never defaulted', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'missing-chat-1' })]);
    mockLatestChatActivity.mockResolvedValue(new Map());

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
    expect(result.foundInactive).toBe(0);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      { engagementId: 'missing-chat-1' },
      'Case inactivity sweep: chat-activity Map miss — candidate skipped, lastChatActivityAt never defaulted'
    );
    expect(mockLog.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('seam Map miss')
    );
  });

  it('an action-item Map miss is skipped and warned, never defaulted', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'missing-ai-1' })]);
    mockLatestStatusChange.mockResolvedValue(new Map());

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
    expect(result.foundInactive).toBe(0);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      { engagementId: 'missing-ai-1' },
      'Case inactivity sweep: action-item Map miss — candidate skipped, lastActionItemActivityAt never defaulted'
    );
  });

  it('no candidates means no seam, chat or action-item call', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([]);

    const result = await runCaseInactivitySweep(NOW);

    expect(mockConsultationTimestamps).not.toHaveBeenCalled();
    expect(mockLatestChatActivity).not.toHaveBeenCalled();
    expect(mockLatestStatusChange).not.toHaveBeenCalled();
    expect(result.heldByActionItemActivity).toBe(0);
    expect(result.candidates).toBe(0);
    expect(result.heldByChatActivity).toBe(0);
    expect(result.heldByRecentScheduling).toBe(0);
  });
});

describe('case-inactivity sweep — chat activity holds a case open', () => {
  it('chat 1d, no consultation either way: no close, heldByChatActivity 1, no publish or track', async () => {
    oneCase({}, daysAgo(1));

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
    expect(result.foundInactive).toBe(0);
    expect(result.closed).toBe(0);
    expect(result.heldByChatActivity).toBe(1);
    expect(result.heldByRecentScheduling).toBe(0);
    // Nothing inactive ⇒ the exclusion read is never asked.
    expect(mockEngagementIdsWithLiveCaseMeeting).not.toHaveBeenCalled();
  });

  it('chat 31d, nothing else: closes', async () => {
    oneCase({}, daysAgo(31));

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).toHaveBeenCalledWith({ engagementId: 'eng-1', reason: 'auto_inactive' });
    expect(result.closed).toBe(1);
    expect(result.heldByChatActivity).toBe(0);
  });

  it('consultation 40d + chat 2d: held, heldByChatActivity 1', async () => {
    oneCase({ lastCompletedConsultationAt: daysAgo(40) }, daysAgo(2));

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(result.heldByChatActivity).toBe(1);
    expect(result.heldByRecentScheduling).toBe(0);
  });

  it('consultation 2d + chat 40d: held by the consultation, heldByChatActivity 0', async () => {
    oneCase({ lastCompletedConsultationAt: daysAgo(2) }, daysAgo(40));

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(result.foundInactive).toBe(0);
    expect(result.heldByChatActivity).toBe(0);
    expect(result.heldByRecentScheduling).toBe(0);
  });
});

describe('case-inactivity sweep — action-item activity holds a case open', () => {
  /** One candidate whose only activity is an action-item status change `lastToggleAt`. */
  function oneTickedCase(seam: Partial<ConsultationEntry>, lastToggleAt: Date): void {
    oneCase(seam, null);
    mockLatestStatusChange.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, lastToggleAt]))
    );
  }

  it('consultation 40d + an item ticked 2d ago: no close, heldByActionItemActivity 1', async () => {
    oneTickedCase({ lastCompletedConsultationAt: daysAgo(40) }, daysAgo(2));

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(result.foundInactive).toBe(0);
    expect(result.heldByActionItemActivity).toBe(1);
    expect(result.heldByChatActivity).toBe(0);
    expect(result.heldByRecentScheduling).toBe(0);
  });

  it('an item ticked 31d ago, nothing newer: closes', async () => {
    oneTickedCase({ lastCompletedConsultationAt: daysAgo(40) }, daysAgo(31));

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).toHaveBeenCalledWith({ engagementId: 'eng-1', reason: 'auto_inactive' });
    expect(result.heldByActionItemActivity).toBe(0);
  });

  it('chat 2d + an item ticked 2d ago: held, but by neither alone — both counters 0', async () => {
    oneTickedCase({}, daysAgo(2));
    mockLatestChatActivity.mockImplementation(
      async (ids: string[]) => new Map(ids.map((id) => [id, daysAgo(2)]))
    );

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(result.heldByActionItemActivity).toBe(0);
    expect(result.heldByChatActivity).toBe(0);
  });

  it('calls the action-item read with the same ids as the seam, chunked at 500', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => caseRow({ id: `eng-${i}` }));
    mockListOpenCreatedBefore.mockResolvedValue(rows);

    await runCaseInactivitySweep(NOW);

    const seamChunks = (
      mockConsultationTimestamps.mock.calls.slice(0, 2) as [string[], Date][]
    ).map(([ids]) => ids);
    const calls = mockLatestStatusChange.mock.calls.slice(0, 2) as unknown[][];
    expect(calls.map((args) => args.length)).toEqual([1, 1]);
    expect(calls.map(([ids]) => ids)).toEqual(seamChunks);
  });

  it('the re-check re-reads action-item activity and drops a case ticked in between', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);
    let reads = 0;
    mockLatestStatusChange.mockImplementation(async (ids: string[]) => {
      reads += 1;
      const value = reads === 1 ? null : new Date(NOW.getTime() + 60_000);
      return new Map(ids.map((id) => [id, value]));
    });

    const result = await runCaseInactivitySweep(NOW);

    expect(mockLatestStatusChange).toHaveBeenCalledTimes(2);
    expect(mockLatestStatusChange).toHaveBeenLastCalledWith(['eng-1']);
    expect(mockClose).not.toHaveBeenCalled();
    expect(result.foundInactive).toBe(1);
    expect(result.skippedOnRecheck).toBe(1);
  });
});

describe('case-inactivity sweep — scheduling activity holds a case open', () => {
  it('scheduling 2d, nothing else: no close, heldByRecentScheduling 1, heldByChatActivity 0', async () => {
    oneCase({ lastSchedulingActivityAt: daysAgo(2) }, null);

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(result.foundInactive).toBe(0);
    expect(result.heldByRecentScheduling).toBe(1);
    expect(result.heldByChatActivity).toBe(0);
  });

  it('scheduling 31d, nothing else: closes', async () => {
    oneCase({ lastSchedulingActivityAt: daysAgo(31) }, null);

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).toHaveBeenCalledWith({ engagementId: 'eng-1', reason: 'auto_inactive' });
    expect(result.closed).toBe(1);
    expect(result.heldByRecentScheduling).toBe(0);
  });

  it('scheduling 2d + chat 2d: held, but by neither alone — both counters 0', async () => {
    oneCase({ lastSchedulingActivityAt: daysAgo(2) }, daysAgo(2));

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(result.foundInactive).toBe(0);
    expect(result.heldByChatActivity).toBe(0);
    expect(result.heldByRecentScheduling).toBe(0);
  });
});

describe('case-inactivity sweep — both anchor reads are chunked at 500', () => {
  it('calls the seam with exactly the candidate ids, chunked at 500', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => caseRow({ id: `eng-${i}` }));
    mockListOpenCreatedBefore.mockResolvedValue(rows);

    await runCaseInactivitySweep(NOW);

    // First batch pass: two chunks (500 + 1). Each individually-rechecked close then issues
    // its own single-id seam call, so assert the FIRST two calls (the batch pass) precisely.
    const batchCalls = mockConsultationTimestamps.mock.calls.slice(0, 2) as [string[], Date][];
    const chunkSizes = batchCalls.map(([ids]) => ids.length).sort((a, b) => b - a);
    expect(chunkSizes).toEqual([500, 1]);

    const allIds = new Set(batchCalls.flatMap(([ids]) => ids));
    expect(allIds.size).toBe(501);
    for (const row of rows) {
      expect(allIds.has(row.id as string)).toBe(true);
    }
  });

  it('calls the chat read with the same ids as the seam, chunked at 500, one argument each', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => caseRow({ id: `eng-${i}` }));
    mockListOpenCreatedBefore.mockResolvedValue(rows);

    await runCaseInactivitySweep(NOW);

    // The batch pass is the first two calls of each read; every per-case re-check that follows
    // issues its own single-id call.
    const seamChunks = (
      mockConsultationTimestamps.mock.calls.slice(0, 2) as [string[], Date][]
    ).map(([ids]) => ids);
    const chatCalls = mockLatestChatActivity.mock.calls.slice(0, 2) as unknown[][];
    expect(chatCalls.map((args) => args.length)).toEqual([1, 1]);
    const chatChunks = chatCalls.map(([ids]) => ids as string[]);
    expect(chatChunks.map((ids) => ids.length)).toEqual([500, 1]);
    expect(chatChunks).toEqual(seamChunks);
  });
});

describe('case-inactivity sweep — check-then-act', () => {
  it('the re-check drops a case booked in between (skippedOnRecheck)', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);
    mockConsultationTimestamps
      .mockResolvedValueOnce(
        new Map([
          [
            'eng-1',
            {
              lastCompletedConsultationAt: null,
              nextScheduledConsultationAt: null,
              lastSchedulingActivityAt: null,
            },
          ],
        ])
      )
      .mockResolvedValueOnce(
        new Map([
          [
            'eng-1',
            {
              lastCompletedConsultationAt: null,
              nextScheduledConsultationAt: new Date(NOW.getTime() + DAY_MS),
              lastSchedulingActivityAt: null,
            },
          ],
        ])
      );

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(result.skippedOnRecheck).toBe(1);
    expect(result.closed).toBe(0);
    // The batch pass DID find it inactive — that obligation is unaffected by the recheck.
    expect(result.foundInactive).toBe(1);
  });

  it('the re-check re-reads chat activity and drops a case messaged in between (skippedOnRecheck)', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);
    let chatReads = 0;
    mockLatestChatActivity.mockImplementation(async (ids: string[]) => {
      chatReads += 1;
      // The batch pass sees no chat; by the re-check a message has landed (a minute after the
      // tick's `now` — `created_at` is the DB clock, and nothing bounds it by `now`).
      const value = chatReads === 1 ? null : new Date(NOW.getTime() + 60_000);
      return new Map(ids.map((id) => [id, value]));
    });

    const result = await runCaseInactivitySweep(NOW);

    expect(mockLatestChatActivity).toHaveBeenCalledTimes(2);
    expect(mockLatestChatActivity).toHaveBeenLastCalledWith(['eng-1']);
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(result.foundInactive).toBe(1);
    expect(result.skippedOnRecheck).toBe(1);
    expect(result.closed).toBe(0);
  });
});

describe('case-inactivity sweep — the cap', () => {
  it('defers the remainder past MAX_CASE_CLOSES_PER_TICK, oldest first, and warns', async () => {
    const rows = Array.from({ length: 101 }, (_, i) =>
      caseRow({ id: `eng-${i}`, createdAt: new Date(NOW.getTime() - (32 * DAY_MS - i * 1000)) })
    );
    mockListOpenCreatedBefore.mockResolvedValue(rows);

    const result = await runCaseInactivitySweep(NOW);

    expect(result.deferred).toBe(1);
    expect(result.closed).toBe(100);
    expect(mockClose).toHaveBeenCalledTimes(100);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eligible: 101, cap: 100, deferred: 1 }),
      expect.stringContaining('cap')
    );
    // Oldest first: the LAST row (index 100) is the one deferred.
    expect(mockClose).not.toHaveBeenCalledWith({
      engagementId: 'eng-100',
      reason: 'auto_inactive',
    });
  });
});

describe('case-inactivity sweep — the post-commit notice', () => {
  it('publishes engagement.case_closed once, closeReason auto_inactive, no token, owner as recipientId', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);

    await runCaseInactivitySweep(NOW);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [event, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('engagement.case_closed');
    expect(payload).toMatchObject({
      correlationId: 'eng-1:case_closed',
      engagementId: 'eng-1',
      recipientId: 'owner-1',
      closeReason: 'auto_inactive',
      reviewToken: undefined,
    });
  });

  it('owner-miss publishes with recipientId absent, plus a warn — not a failure', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);
    mockFindOwnerUserId.mockResolvedValue(undefined);

    const result = await runCaseInactivitySweep(NOW);

    expect(result.closed).toBe(1);
    expect(result.noticeFailed).toBe(0);
    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.recipientId).toBeUndefined();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ engagementId: 'eng-1', companyId: 'co-1' }),
      expect.stringContaining('owner')
    );
  });

  it('never mints a review token — mintReviewInviteToken is not called', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);

    await runCaseInactivitySweep(NOW);

    expect(mockMintReviewInviteToken).not.toHaveBeenCalled();
  });

  it('noticeFailed leaves closed intact', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);
    mockPublish.mockRejectedValueOnce(new Error('transport down'));

    const result = await runCaseInactivitySweep(NOW);

    expect(result.closed).toBe(1);
    expect(result.noticeFailed).toBe(1);
    // The close and the track already happened — a lost notice must not un-count either.
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledTimes(1);
    // The lost-notice runbook (docs/ops/case-inactivity-sweep-lost-notices.md) queries this
    // literal word for word — a reword breaks the query silently.
    expect(mockLog.error).toHaveBeenCalledWith(
      { engagementId: 'eng-1', error: 'transport down', stack: expect.any(String) },
      'Case inactivity sweep: post-commit notice failed'
    );
  });
});

describe('case-inactivity sweep — case_resolved analytics', () => {
  it('tracks case_resolved with source sweep and the system distinct id, exactly once per close', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);

    await runCaseInactivitySweep(NOW);

    expect(mockTrackServer).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledWith('case_resolved', {
      source: 'sweep',
      engagement_id: 'eng-1',
      distinct_id: 'system:case-inactivity',
    });
  });

  it('never fires for a held, chat-held, scheduling-held, skipped-on-recheck or already-closed case — only for the real close', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([
      caseRow({ id: 'held-1' }),
      caseRow({ id: 'chat-held-1' }),
      caseRow({ id: 'scheduling-held-1' }),
      caseRow({ id: 'recheck-drop-1' }),
      caseRow({ id: 'already-closed-1' }),
      caseRow({ id: 'closes-1' }),
    ]);
    mockLatestChatActivity.mockImplementation(
      async (ids: string[]) =>
        new Map(
          ids.map((id) => [id, id === 'chat-held-1' ? new Date(NOW.getTime() - DAY_MS) : null])
        )
    );
    mockEngagementIdsWithLiveCaseMeeting.mockImplementation(async (ids: string[]) =>
      ids.includes('held-1') ? new Set(['held-1']) : new Set<string>()
    );
    // `recheck-drop-1` looks inactive on the BATCH pass (queried alongside the other ids, so
    // `ids.length > 1`), but has since gained a future booking by the time its own RE-CHECK
    // queries the seam — a single-element `['recheck-drop-1']` array, which only `closeOne`'s
    // per-case recheck ever issues. `scheduling-held-1` is held by a booking two days ago alone.
    mockConsultationTimestamps.mockImplementation(async (ids: string[], now: Date) => {
      const [onlyId] = ids;
      if (ids.length === 1 && onlyId === 'recheck-drop-1') {
        return new Map([
          [
            'recheck-drop-1',
            {
              lastCompletedConsultationAt: null,
              nextScheduledConsultationAt: new Date(now.getTime() + DAY_MS),
              lastSchedulingActivityAt: null,
            },
          ],
        ]);
      }
      return new Map(
        ids.map((id) => [
          id,
          {
            ...NO_SEAM_ACTIVITY,
            lastSchedulingActivityAt: id === 'scheduling-held-1' ? daysAgo(2) : null,
          },
        ])
      );
    });
    mockClose.mockImplementation(async (input: { engagementId: string }) => {
      if (input.engagementId === 'already-closed-1') {
        throw new CaseAlreadyClosedError('already-closed-1', NOW);
      }
      return caseRow({ id: input.engagementId, closedAt: NOW });
    });

    const result = await runCaseInactivitySweep(NOW);

    expect(result.heldByLiveMeeting).toBe(1);
    expect(result.heldByChatActivity).toBe(1);
    expect(result.heldByRecentScheduling).toBe(1);
    expect(result.skippedOnRecheck).toBe(1);
    expect(result.alreadyClosed).toBe(1);
    expect(result.closed).toBe(1);
    expect(mockClose).not.toHaveBeenCalledWith(
      expect.objectContaining({ engagementId: 'chat-held-1' })
    );
    expect(mockClose).not.toHaveBeenCalledWith(
      expect.objectContaining({ engagementId: 'scheduling-held-1' })
    );
    expect(mockTrackServer).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledWith(
      'case_resolved',
      expect.objectContaining({ engagement_id: 'closes-1' })
    );
  });
});

describe('case-inactivity sweep — error isolation', () => {
  it('CaseAlreadyClosedError on A: no publish, no track for A; B still closes, publishes and tracks', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'a' }), caseRow({ id: 'b' })]);
    mockClose.mockImplementation(async (input: { engagementId: string }) => {
      if (input.engagementId === 'a') {
        throw new CaseAlreadyClosedError('a', NOW);
      }
      return caseRow({ id: 'b', closedAt: NOW });
    });

    const result = await runCaseInactivitySweep(NOW);

    expect(result.alreadyClosed).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledWith(
      'case_resolved',
      expect.objectContaining({ engagement_id: 'b' })
    );
  });

  it('a generic close error on A counts failed, B continues, and logger.error fires', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'a' }), caseRow({ id: 'b' })]);
    mockClose.mockImplementation(async (input: { engagementId: string }) => {
      if (input.engagementId === 'a') {
        throw new Error('connection terminated');
      }
      return caseRow({ id: 'b', closedAt: NOW });
    });

    const messages: string[] = [];
    const result = await runCaseInactivitySweep(NOW, (m) => messages.push(m));

    expect(result.failed).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.alreadyClosed).toBe(0);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ engagementId: 'a' }),
      expect.stringContaining('close failed')
    );
    expect(messages.join('\n')).toContain('close failed for engagement a:');
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('the re-check throwing for A counts failed with a logged stack; B still closes, publishes and tracks; the summary log still fires', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'a' }), caseRow({ id: 'b' })]);
    mockConsultationTimestamps.mockImplementation(async (ids: string[]) => {
      if (ids.length === 1 && ids[0] === 'a') {
        throw new Error('connection reset');
      }
      return neverConsultedMap(ids);
    });

    const messages: string[] = [];
    const result = await runCaseInactivitySweep(NOW, (m) => messages.push(m));

    expect(result.failed).toBe(1);
    expect(result.closed).toBe(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledWith({ engagementId: 'b', reason: 'auto_inactive' });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledTimes(1);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ engagementId: 'a', stack: expect.any(String) }),
      expect.stringContaining('re-check failed')
    );
    expect(messages.join('\n')).toContain('re-check failed for engagement a:');
    // The summary log — and its job.log mirror — still fire despite the mid-tick throw.
    expect(mockLog.info).toHaveBeenCalledWith(result, 'Case inactivity sweep complete');
    expect(messages.some((m) => m.includes('1 closed'))).toBe(true);
  });

  it('the CHAT read throwing on the re-check of A counts failed; B still closes, publishes and tracks', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'a' }), caseRow({ id: 'b' })]);
    mockLatestChatActivity.mockImplementation(async (ids: string[]) => {
      const [onlyId] = ids;
      if (ids.length === 1 && onlyId === 'a') {
        throw new Error('chat read timed out');
      }
      return noChatMap(ids);
    });

    const messages: string[] = [];
    const result = await runCaseInactivitySweep(NOW, (m) => messages.push(m));

    expect(result.failed).toBe(1);
    expect(result.closed).toBe(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledWith({ engagementId: 'b', reason: 'auto_inactive' });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledWith(
      'case_resolved',
      expect.objectContaining({ engagement_id: 'b' })
    );
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ engagementId: 'a', error: 'chat read timed out' }),
      'Case inactivity sweep: re-check failed'
    );
    expect(messages.join('\n')).toContain('re-check failed for engagement a: chat read timed out');
  });
});

describe('case-inactivity sweep — a batch-pass read failure', () => {
  const BATCH_READ_FAILED =
    'Case inactivity sweep: batch read failed — tick aborted, nothing closed';

  it.each([
    [
      'the candidate superset',
      () => mockListOpenCreatedBefore.mockRejectedValue(new Error('boom')),
    ],
    ['the seam', () => mockConsultationTimestamps.mockRejectedValue(new Error('boom'))],
    ['the chat read', () => mockLatestChatActivity.mockRejectedValue(new Error('boom'))],
    ['the action-item read', () => mockLatestStatusChange.mockRejectedValue(new Error('boom'))],
    [
      'the live-meeting exclusion',
      () => mockEngagementIdsWithLiveCaseMeeting.mockRejectedValue(new Error('boom')),
    ],
  ])(
    '%s throwing aborts the tick: logged at error and in job.log, rethrown, nothing closed',
    async (_read, breakRead) => {
      mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);
      breakRead();
      const messages: string[] = [];

      await expect(runCaseInactivitySweep(NOW, (m) => messages.push(m))).rejects.toThrow('boom');

      expect(mockClose).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
      expect(mockTrackServer).not.toHaveBeenCalled();
      expect(mockLog.error).toHaveBeenCalledTimes(1);
      expect(mockLog.error).toHaveBeenCalledWith(
        { error: 'boom', stack: expect.any(String) },
        BATCH_READ_FAILED
      );
      expect(mockLog.info).not.toHaveBeenCalledWith(
        expect.anything(),
        'Case inactivity sweep complete'
      );
      expect(messages).toEqual([
        'case inactivity sweep: batch read failed — tick aborted, nothing closed: boom',
      ]);
    }
  );
});

describe('case-inactivity sweep — the summary log', () => {
  it('logs one structured summary per run with every counter, mirrored to job.log', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);
    const messages: string[] = [];

    const result = await runCaseInactivitySweep(NOW, (m) => messages.push(m));

    expect(mockLog.info).toHaveBeenCalledWith(result, 'Case inactivity sweep complete');
    expect(messages.some((m) => m.includes('1 closed'))).toBe(true);
  });

  /**
   * `closes` makes this a tick with an inactive case, so `partition` leaves through its FINAL
   * return (after the live-meeting exclusion) — the path a production tick almost always takes.
   * The all-active early return is pinned by the one-case chat and scheduling tests above.
   */
  it('reports every sole-holder counter in the result, the summary log and job.log, on a tick that also closes', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([
      caseRow({ id: 'action-item-held' }),
      caseRow({ id: 'chat-held' }),
      caseRow({ id: 'scheduling-held' }),
      caseRow({ id: 'scheduling-held-2' }),
      caseRow({ id: 'closes' }),
    ]);
    mockConsultationTimestamps.mockImplementation(
      async (ids: string[]) =>
        new Map(
          ids.map((id) => [
            id,
            {
              ...NO_SEAM_ACTIVITY,
              lastSchedulingActivityAt: id.startsWith('scheduling-held') ? daysAgo(3) : null,
            },
          ])
        )
    );
    mockLatestChatActivity.mockImplementation(
      async (ids: string[]) =>
        new Map(ids.map((id) => [id, id === 'chat-held' ? daysAgo(3) : null]))
    );
    mockLatestStatusChange.mockImplementation(
      async (ids: string[]) =>
        new Map(ids.map((id) => [id, id === 'action-item-held' ? daysAgo(3) : null]))
    );
    const messages: string[] = [];

    const result = await runCaseInactivitySweep(NOW, (m) => messages.push(m));

    expect(result).toMatchObject({
      candidates: 5,
      foundInactive: 1,
      heldByChatActivity: 1,
      heldByRecentScheduling: 2,
      heldByActionItemActivity: 1,
      closed: 1,
    });
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledWith({ engagementId: 'closes', reason: 'auto_inactive' });
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        heldByChatActivity: 1,
        heldByRecentScheduling: 2,
        heldByActionItemActivity: 1,
      }),
      'Case inactivity sweep complete'
    );
    const summary = messages.join('\n');
    expect(summary).toContain('1 held by chat activity');
    expect(summary).toContain('2 held by recent scheduling');
    expect(summary).toContain('1 held by action-item activity');
  });
});
