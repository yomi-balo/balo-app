import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-572 — unit coverage for the sweep body (`runCaseInactivitySweep`), exported precisely so
 * it can be exercised without a Redis-backed Worker.
 *
 * What is REAL (pure, unmocked): `isCaseInactive` / `CASE_INACTIVITY_DAYS` /
 * `buildCaseClosedPayload` / `summariseCaseCloseAnchors` (`@balo/shared/engagements`) — the
 * inactivity rule and the payload assembly are the thing under test, not a fixture to
 * hand-answer. `MEETING_TOKEN_TTL_AFTER_END_MS` (`../services/meetings/meeting-liveness.js`)
 * and `LIFECYCLE_LOOKBACK_MS` (`./meeting-lifecycle-sweep.js`) are also real constants.
 *
 * What is MOCKED: `@balo/db` (every repository call), the logger, `@balo/analytics/server`,
 * the notification publisher, and BullMQ's `Worker` (a real one would try a live Redis
 * connection and hang the suite).
 */

const {
  mockListOpenCreatedBefore,
  mockClose,
  mockConsultationTimestamps,
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
  mockQueueAdd,
  mockMintReviewInviteToken,
} = vi.hoisted(() => ({
  mockListOpenCreatedBefore: vi.fn(),
  mockClose: vi.fn(),
  mockConsultationTimestamps: vi.fn(),
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

vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLog }));

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
};

/** Every requested id answers "never consulted" — inactive by anchors, unless overridden. */
function neverConsultedMap(ids: readonly string[]): Map<string, ConsultationEntry> {
  return new Map(
    ids.map((id) => [id, { lastCompletedConsultationAt: null, nextScheduledConsultationAt: null }])
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListOpenCreatedBefore.mockResolvedValue([]);
  mockConsultationTimestamps.mockImplementation(async (ids: string[]) => neverConsultedMap(ids));
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
          },
        ],
      ])
    );

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
    expect(result.foundInactive).toBe(0);
  });

  it('a { null, null } entry, created 31 days before now, closes', async () => {
    const createdAt = new Date(NOW.getTime() - 31 * DAY_MS);
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1', createdAt })]);
    mockConsultationTimestamps.mockResolvedValue(
      new Map([['eng-1', { lastCompletedConsultationAt: null, nextScheduledConsultationAt: null }]])
    );

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).toHaveBeenCalledWith({ engagementId: 'eng-1', reason: 'auto_inactive' });
    expect(result.closed).toBe(1);
  });

  it('a seam-Map miss is skipped and warned, never defaulted', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'missing-1' })]);
    mockConsultationTimestamps.mockResolvedValue(new Map());

    const result = await runCaseInactivitySweep(NOW);

    expect(mockClose).not.toHaveBeenCalled();
    expect(result.closed).toBe(0);
    expect(result.foundInactive).toBe(0);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ engagementId: 'missing-1' }),
      expect.stringContaining('seam')
    );
  });

  it('no candidates means no seam call', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([]);

    const result = await runCaseInactivitySweep(NOW);

    expect(mockConsultationTimestamps).not.toHaveBeenCalled();
    expect(result.candidates).toBe(0);
  });
});

describe('case-inactivity sweep — the seam is chunked at 500', () => {
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
});

describe('case-inactivity sweep — check-then-act', () => {
  it('the re-check drops a case booked in between (skippedOnRecheck)', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);
    mockConsultationTimestamps
      .mockResolvedValueOnce(
        new Map([
          ['eng-1', { lastCompletedConsultationAt: null, nextScheduledConsultationAt: null }],
        ])
      )
      .mockResolvedValueOnce(
        new Map([
          [
            'eng-1',
            {
              lastCompletedConsultationAt: null,
              nextScheduledConsultationAt: new Date(NOW.getTime() + DAY_MS),
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

  it('never fires for a held, skipped-on-recheck or already-closed case — only for the real close', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([
      caseRow({ id: 'held-1' }),
      caseRow({ id: 'recheck-drop-1' }),
      caseRow({ id: 'already-closed-1' }),
      caseRow({ id: 'closes-1' }),
    ]);
    mockEngagementIdsWithLiveCaseMeeting.mockImplementation(async (ids: string[]) =>
      ids.includes('held-1') ? new Set(['held-1']) : new Set<string>()
    );
    // `recheck-drop-1` looks inactive on the BATCH pass (queried alongside the other three
    // ids, so `ids.length > 1`), but has since gained a future booking by the time its own
    // RE-CHECK queries the seam — a single-element `['recheck-drop-1']` array, which only
    // `closeOne`'s per-case recheck ever issues.
    mockConsultationTimestamps.mockImplementation(async (ids: string[], now: Date) => {
      const [onlyId] = ids;
      if (ids.length === 1 && onlyId === 'recheck-drop-1') {
        return new Map([
          [
            'recheck-drop-1',
            {
              lastCompletedConsultationAt: null,
              nextScheduledConsultationAt: new Date(now.getTime() + DAY_MS),
            },
          ],
        ]);
      }
      return neverConsultedMap(ids);
    });
    mockClose.mockImplementation(async (input: { engagementId: string }) => {
      if (input.engagementId === 'already-closed-1') {
        throw new CaseAlreadyClosedError('already-closed-1', NOW);
      }
      return caseRow({ id: input.engagementId, closedAt: NOW });
    });

    const result = await runCaseInactivitySweep(NOW);

    expect(result.heldByLiveMeeting).toBe(1);
    expect(result.skippedOnRecheck).toBe(1);
    expect(result.alreadyClosed).toBe(1);
    expect(result.closed).toBe(1);
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
});

describe('case-inactivity sweep — the summary log', () => {
  it('logs one structured summary per run with every counter, mirrored to job.log', async () => {
    mockListOpenCreatedBefore.mockResolvedValue([caseRow({ id: 'eng-1' })]);
    const messages: string[] = [];

    const result = await runCaseInactivitySweep(NOW, (m) => messages.push(m));

    expect(mockLog.info).toHaveBeenCalledWith(result, 'Case inactivity sweep complete');
    expect(messages.some((m) => m.includes('1 closed'))).toBe(true);
  });
});
