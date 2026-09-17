/**
 * BAL-566 — unit tests (no Docker) for the pure helpers behind
 * `upcomingMeetingsRepository.listForCompany`, plus the empty-input and range-guard paths that
 * must return or throw WITHOUT touching the database.
 *
 * ⚠ `db` is `undefined` in this process (no `DATABASE_URL`, no `_setDb`), so ANY query attempt
 * throws a TypeError. That is what makes "resolves with no query" provable here rather than
 * asserted by inspection. The tenancy guarantee itself is pinned against real Postgres in
 * `upcoming-meetings.integration.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ⚠ `vi.hoisted` — `createLogger` is called at IMPORT time, above any plain `const`.
const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  }),
}));

import type { FoldedCalendarMeeting } from './meetings';
import {
  assembleCompanyUpcomingMeetings,
  assertUpcomingRange,
  assertUpcomingRowCap,
  indexVisibleContexts,
  MAX_UPCOMING_CONTEXT_ROWS,
  MAX_UPCOMING_RANGE_DAYS,
  upcomingMeetingsRepository,
  UpcomingMeetingsRangeTooWideError,
  UpcomingMeetingsTooManyRowsError,
  type VisibleCompanyContext,
} from './upcoming-meetings';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Fixture instants derived from the test-time clock — never a hardcoded calendar date. */
const NOW = new Date(Date.now());
const START = new Date(NOW.getTime() + HOUR_MS);
const END = new Date(NOW.getTime() + 2 * HOUR_MS);

beforeEach(() => {
  mockLoggerWarn.mockClear();
});

function folded(overrides: Partial<FoldedCalendarMeeting> = {}): FoldedCalendarMeeting {
  return {
    meetingId: 'm1',
    scheduledStart: START,
    scheduledEnd: END,
    status: 'scheduled',
    contextType: 'case',
    contextId: 'engagement-1',
    ...overrides,
  };
}

function visible(overrides: Partial<VisibleCompanyContext> = {}): VisibleCompanyContext {
  return {
    meetingId: 'm1',
    contextType: 'case',
    contextId: 'engagement-1',
    projectRequestId: null,
    expertProfileId: 'expert-1',
    ...overrides,
  };
}

describe('assertUpcomingRange', () => {
  it('accepts the only caller’s window (now − 2h .. now + 14d)', () => {
    expect(() =>
      assertUpcomingRange(
        new Date(NOW.getTime() - 2 * HOUR_MS),
        new Date(NOW.getTime() + 14 * DAY_MS)
      )
    ).not.toThrow();
  });

  it('accepts a span of exactly MAX_UPCOMING_RANGE_DAYS', () => {
    expect(() =>
      assertUpcomingRange(NOW, new Date(NOW.getTime() + MAX_UPCOMING_RANGE_DAYS * DAY_MS))
    ).not.toThrow();
  });

  it('throws UpcomingMeetingsRangeTooWideError one millisecond past the cap, naming both bounds', () => {
    const rangeEnd = new Date(NOW.getTime() + MAX_UPCOMING_RANGE_DAYS * DAY_MS + 1);
    expect(() => assertUpcomingRange(NOW, rangeEnd)).toThrow(UpcomingMeetingsRangeTooWideError);
    expect(() => assertUpcomingRange(NOW, rangeEnd)).toThrow(
      `listForCompany: range ${NOW.toISOString()}..${rangeEnd.toISOString()} exceeds the maximum of ${MAX_UPCOMING_RANGE_DAYS} days`
    );
  });

  it('throws ITS error (not a RangeError from toISOString) for an Invalid Date bound', () => {
    const invalid = new Date(Number.NaN);
    expect(() => assertUpcomingRange(invalid, NOW)).toThrow(UpcomingMeetingsRangeTooWideError);
    expect(() => assertUpcomingRange(NOW, invalid)).toThrow(/\.\.Invalid Date exceeds/);
  });

  it('keeps headroom over the caller’s 14d + 2h window', () => {
    expect(MAX_UPCOMING_RANGE_DAYS * DAY_MS).toBeGreaterThan(14 * DAY_MS + 2 * HOUR_MS);
  });
});

describe('assertUpcomingRowCap', () => {
  it('throws UpcomingMeetingsTooManyRowsError AT the limit, naming the company, arm and cap', () => {
    expect(() =>
      assertUpcomingRowCap(MAX_UPCOMING_CONTEXT_ROWS, 'company-7', 'request_interaction')
    ).toThrow(UpcomingMeetingsTooManyRowsError);
    expect(() =>
      assertUpcomingRowCap(MAX_UPCOMING_CONTEXT_ROWS, 'company-7', 'request_interaction')
    ).toThrow(
      `company company-7 has at least ${MAX_UPCOMING_CONTEXT_ROWS} request_interaction context rows`
    );
  });

  it('does not throw one row below the limit — every real call', () => {
    expect(() =>
      assertUpcomingRowCap(MAX_UPCOMING_CONTEXT_ROWS - 1, 'company-7', 'case')
    ).not.toThrow();
  });
});

describe('indexVisibleContexts', () => {
  it('keys each context by its exact (meeting, type, id) triple and de-duplicates candidate meetings in first-seen order', () => {
    const contexts = [
      visible({ meetingId: 'm2', contextType: 'project_discovery', contextId: 'request-1' }),
      visible({ meetingId: 'm1' }),
      visible({ meetingId: 'm2', contextType: 'project_kickoff', contextId: 'engagement-2' }),
    ];

    const { visibleByKey, candidateMeetingIds } = indexVisibleContexts(contexts);

    expect(candidateMeetingIds).toEqual(['m2', 'm1']);
    expect(visibleByKey.size).toBe(3);
    expect(visibleByKey.get('m2:project_discovery:request-1')).toBe(contexts[0]);
    expect(visibleByKey.get('m1:case:engagement-1')).toBe(contexts[1]);
    expect(visibleByKey.get('m2:project_kickoff:engagement-2')).toBe(contexts[2]);
  });

  it('an empty step 1 yields no candidates', () => {
    const { visibleByKey, candidateMeetingIds } = indexVisibleContexts([]);
    expect(candidateMeetingIds).toEqual([]);
    expect(visibleByKey.size).toBe(0);
  });
});

describe('assembleCompanyUpcomingMeetings — step 3, the ownership check', () => {
  it('a hit keeps the meeting, taking the owner scalars from the VISIBLE row', () => {
    const { visibleByKey } = indexVisibleContexts([
      visible({
        meetingId: 'm1',
        contextType: 'request_interaction',
        contextId: 'relationship-1',
        projectRequestId: 'request-9',
        expertProfileId: 'expert-3',
      }),
    ]);

    const result = assembleCompanyUpcomingMeetings(
      [
        folded({
          status: 'in_progress',
          contextType: 'request_interaction',
          contextId: 'relationship-1',
        }),
      ],
      visibleByKey,
      'company-a'
    );

    expect(result).toHaveLength(1);
    expect(result).toEqual([
      {
        meetingId: 'm1',
        scheduledStart: START,
        scheduledEnd: END,
        status: 'in_progress',
        contextType: 'request_interaction',
        contextId: 'relationship-1',
        projectRequestId: 'request-9',
        expertProfileId: 'expert-3',
        owningRowFound: true,
      },
    ]);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE FORGED-CONTEXT SHAPE, IN PURE FORM. The company reached `m1` through its own discovery
   * context, but the fold's winner is ANOTHER tenant's case. The meeting is omitted, and the log
   * line carries NO `contextId` — the winner here is by construction a foreign identifier.
   */
  it('a miss (winner is not a company-visible context) omits the meeting and logs WITHOUT the contextId', () => {
    const { visibleByKey } = indexVisibleContexts([
      visible({
        meetingId: 'm1',
        contextType: 'project_discovery',
        contextId: 'request-a',
        projectRequestId: 'request-a',
      }),
    ]);

    const result = assembleCompanyUpcomingMeetings(
      [folded({ meetingId: 'm1', contextType: 'case', contextId: 'foreign-engagement' })],
      visibleByKey,
      'company-a'
    );

    expect(result).toHaveLength(0);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { meetingId: 'm1', companyId: 'company-a', contextType: 'case' },
      'Meeting omitted from the company upcoming read: primary context is not owned by the company'
    );
    expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('foreign-engagement');
  });

  it('matches on the WHOLE triple — the same id under another type, or on another meeting, is a miss', () => {
    const { visibleByKey } = indexVisibleContexts([
      visible({ meetingId: 'm1', contextType: 'project_discovery', contextId: 'shared-id' }),
    ]);

    const result = assembleCompanyUpcomingMeetings(
      [
        folded({ meetingId: 'm1', contextType: 'case', contextId: 'shared-id' }),
        folded({ meetingId: 'm2', contextType: 'project_discovery', contextId: 'shared-id' }),
      ],
      visibleByKey,
      'company-a'
    );

    expect(result).toHaveLength(0);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
  });

  it('preserves input order (the step-2 SQL order) and drops only the misses', () => {
    const { visibleByKey } = indexVisibleContexts([
      visible({ meetingId: 'm3', contextId: 'engagement-3' }),
      visible({ meetingId: 'm1', contextId: 'engagement-1' }),
    ]);

    const result = assembleCompanyUpcomingMeetings(
      [
        folded({ meetingId: 'm1', contextId: 'engagement-1' }),
        folded({ meetingId: 'm2', contextId: 'engagement-foreign' }),
        folded({ meetingId: 'm3', contextId: 'engagement-3' }),
      ],
      visibleByKey,
      'company-a'
    );

    expect(result.map((row) => row.meetingId)).toEqual(['m1', 'm3']);
    expect(result.filter((row) => row.owningRowFound)).toHaveLength(2);
  });
});

describe('upcomingMeetingsRepository — paths that must never reach the database', () => {
  it('findTitles with three empty id lists runs no query and returns three empty maps', async () => {
    const titles = await upcomingMeetingsRepository.findTitles({
      caseEngagementIds: [],
      kickoffEngagementIds: [],
      projectRequestIds: [],
    });

    expect(titles.caseTitleByEngagementId.size).toBe(0);
    expect(titles.kickoffRequestTitleByEngagementId.size).toBe(0);
    expect(titles.requestTitleById.size).toBe(0);
  });

  it('findExpertPartyNames([]) runs no query and returns []', async () => {
    await expect(upcomingMeetingsRepository.findExpertPartyNames([])).resolves.toEqual([]);
  });

  it('listForCompany refuses a too-wide range BEFORE any query', async () => {
    await expect(
      upcomingMeetingsRepository.listForCompany({
        companyId: 'company-a',
        rangeStart: NOW,
        rangeEnd: new Date(NOW.getTime() + (MAX_UPCOMING_RANGE_DAYS + 1) * DAY_MS),
      })
    ).rejects.toBeInstanceOf(UpcomingMeetingsRangeTooWideError);
  });
});
