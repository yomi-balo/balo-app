/**
 * BAL-498 — table tests for the pure fold/classify/assemble helpers behind
 * `meetingsRepository.listCalendarForExpert`, extracted from the method to bring its
 * `sonarjs/cognitive-complexity` under the SonarCloud gate (fix round 1, B5). These run WITHOUT
 * Docker — the security-critical tenant-isolation behaviour itself stays pinned by the real
 * Postgres integration cases in `meetings.integration.test.ts` (plan-bal-498.md § 12.3); this
 * file only covers the precedence/bucketing/assembly LOGIC.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * R9 — the fold's "OMITTED, fail-closed, and logged" promise is now true for BOTH reasons, so the
 * logger has to be observable here. A module-level mock: `createLogger` is called at import time.
 */
// ⚠ `vi.hoisted` — `vi.mock` is hoisted ABOVE plain const declarations, and `createLogger` is
// called at IMPORT time (`client.ts` -> `meetings.ts`), so a bare `const` here throws
// "Cannot access 'mockLoggerWarn' before initialization" before a single test runs.
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

import {
  foldMeetingContextRows,
  foldMeetingContextRowsToPrimary,
  classifyCalendarContextIds,
  assembleCalendarMeetings,
  assertCalendarRowCapNotExceeded,
  CalendarTooManyRowsError,
  MAX_CALENDAR_ROWS,
  MAX_CALENDAR_RANGE_DAYS,
} from './meetings';

beforeEach(() => {
  mockLoggerWarn.mockClear();
});

const START = new Date('2026-08-24T09:00:00.000Z');
const END = new Date('2026-08-24T09:30:00.000Z');

describe('foldMeetingContextRowsToPrimary', () => {
  it('a meeting with one context row folds to that context, fields carried through', () => {
    const folded = foldMeetingContextRowsToPrimary(
      [
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'case',
          contextId: 'engagement-1',
          roomReady: true,
        },
      ],
      'expert-1'
    );

    expect(folded).toEqual([
      {
        meetingId: 'm1',
        scheduledStart: START,
        scheduledEnd: END,
        status: 'scheduled',
        contextType: 'case',
        contextId: 'engagement-1',
        roomReady: true,
      },
    ]);
  });

  it('precedence: project_discovery + project_kickoff on the same meeting folds to project_kickoff ONCE', () => {
    const folded = foldMeetingContextRowsToPrimary(
      [
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'project_discovery',
          contextId: 'request-1',
          roomReady: true,
        },
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'project_kickoff',
          contextId: 'engagement-1',
          roomReady: true,
        },
      ],
      'expert-1'
    );

    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ contextType: 'project_kickoff', contextId: 'engagement-1' });
  });

  it('an admin-only context (no holder) folds to NOTHING — omitted, not defaulted', () => {
    const folded = foldMeetingContextRowsToPrimary(
      [
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'admin',
          contextId: null,
          roomReady: true,
        },
      ],
      'expert-1'
    );

    expect(folded).toEqual([]);
  });

  /**
   * R9 — the method docblock promised a meeting folding to `'none'` OR `'ambiguous'` was
   * "OMITTED, fail-closed, and logged", but only `'ambiguous'` was ever logged; `'none'` fell
   * through a bare `continue`. That hid a genuinely bad state: the meeting still occupies the
   * expert's availability through `consultations` while vanishing from their calendar, with no
   * log line to notice it by.
   */
  it('an admin-only context is LOGGED with reason "none", not dropped silently (R9)', () => {
    foldMeetingContextRowsToPrimary(
      [
        {
          meetingId: 'm-silent',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'admin',
          contextId: null,
          roomReady: true,
        },
      ],
      'expert-1'
    );

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: 'm-silent',
        expertProfileId: 'expert-1',
        reason: 'none',
      }),
      expect.any(String)
    );
  });

  it('two DISTINCT top-tier contexts on one meeting are ambiguous and the meeting is dropped', () => {
    const folded = foldMeetingContextRowsToPrimary(
      [
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'case',
          contextId: 'engagement-1',
          roomReady: true,
        },
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'project_kickoff',
          contextId: 'engagement-2',
          roomReady: true,
        },
      ],
      'expert-1'
    );

    expect(folded).toEqual([]);
    // The reason rides into the log line, so the two omission causes are distinguishable in
    // Axiom rather than collapsed into one message (R9).
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'm1', reason: 'ambiguous' }),
      expect.any(String)
    );
  });

  it('multiple independent meetings each fold to their own row, order preserved', () => {
    const folded = foldMeetingContextRowsToPrimary(
      [
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'case',
          contextId: 'engagement-1',
          roomReady: true,
        },
        {
          meetingId: 'm2',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'request_interaction',
          contextId: 'relationship-1',
          roomReady: true,
        },
      ],
      'expert-1'
    );

    expect(folded.map((row) => row.meetingId)).toEqual(['m1', 'm2']);
  });

  /**
   * BAL-566 — the wrapper's log line is now built in a callback over `foldMeetingContextRows`.
   * Monitors may key on the message, so it is pinned VERBATIM (full literal, never
   * `expect.any(String)`) along with the exact payload — the extraction must not have reworded it
   * or dropped the expert scope.
   */
  it('the wrapper still logs the byte-identical message with the expert scope (BAL-566 extraction)', () => {
    const folded = foldMeetingContextRowsToPrimary(
      [
        {
          meetingId: 'm-none',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'admin',
          contextId: null,
          roomReady: true,
        },
      ],
      'expert-9'
    );

    expect(folded).toHaveLength(0);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { meetingId: 'm-none', expertProfileId: 'expert-9', reason: 'none' },
      'Meeting omitted from the expert calendar read: no usable primary context'
    );
  });
});

/**
 * BAL-566 D3 — the SCOPE-AGNOSTIC core both the expert calendar and the company Up next read
 * fold through. It reports omissions to its caller and logs NOTHING itself: the log line (and
 * the scope it names) belongs to the caller.
 */
describe('foldMeetingContextRows', () => {
  it('carries the precedence winner through, one row per meeting, and reports no omission', () => {
    const onOmitted = vi.fn();
    const folded = foldMeetingContextRows(
      [
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'in_progress',
          contextType: 'project_discovery',
          contextId: 'request-1',
          roomReady: true,
        },
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'in_progress',
          contextType: 'project_kickoff',
          contextId: 'engagement-1',
          roomReady: true,
        },
      ],
      onOmitted
    );

    expect(folded).toHaveLength(1);
    expect(folded).toEqual([
      {
        meetingId: 'm1',
        scheduledStart: START,
        scheduledEnd: END,
        status: 'in_progress',
        contextType: 'project_kickoff',
        contextId: 'engagement-1',
        roomReady: true,
      },
    ]);
    expect(onOmitted).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("a meeting with no usable context calls onOmitted(meetingId, 'none') and is dropped", () => {
    const onOmitted = vi.fn();
    const folded = foldMeetingContextRows(
      [
        {
          meetingId: 'm-admin',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'admin',
          contextId: null,
          roomReady: true,
        },
        {
          meetingId: 'm-kept',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'case',
          contextId: 'engagement-1',
          roomReady: true,
        },
      ],
      onOmitted
    );

    expect(folded).toHaveLength(1);
    expect(folded[0]?.meetingId).toBe('m-kept');
    expect(onOmitted).toHaveBeenCalledTimes(1);
    expect(onOmitted).toHaveBeenCalledWith('m-admin', 'none');
    // The core never logs on the caller's behalf.
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("two distinct top-tier contexts call onOmitted(meetingId, 'ambiguous') and the meeting is dropped", () => {
    const onOmitted = vi.fn();
    const folded = foldMeetingContextRows(
      [
        {
          meetingId: 'm-ambiguous',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'project_discovery',
          contextId: 'request-1',
          roomReady: true,
        },
        {
          meetingId: 'm-ambiguous',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'request_interaction',
          contextId: 'relationship-1',
          roomReady: true,
        },
      ],
      onOmitted
    );

    expect(folded).toHaveLength(0);
    expect(onOmitted).toHaveBeenCalledTimes(1);
    expect(onOmitted).toHaveBeenCalledWith('m-ambiguous', 'ambiguous');
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  /**
   * BAL-581 — `roomReady` is per-MEETING (the SQL twin over the meeting's own columns), so the
   * fold copies it from the meeting's rows onto the folded row. Both values appear here so a
   * copy hard-wired to either literal fails.
   */
  it("copies each meeting's roomReady onto its folded row, true and false alike", () => {
    const folded = foldMeetingContextRows(
      [
        {
          meetingId: 'm-ready',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'project_discovery',
          contextId: 'request-1',
          roomReady: true,
        },
        {
          meetingId: 'm-ready',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'project_kickoff',
          contextId: 'engagement-1',
          roomReady: true,
        },
        {
          meetingId: 'm-not-ready',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'case',
          contextId: 'engagement-2',
          roomReady: false,
        },
      ],
      vi.fn()
    );

    expect(folded).toHaveLength(2);
    expect(folded.map((row) => [row.meetingId, row.roomReady])).toEqual([
      ['m-ready', true],
      ['m-not-ready', false],
    ]);
  });
});

describe('classifyCalendarContextIds', () => {
  it('buckets the four engagement-grain labels into engagementIds', () => {
    const folded = (
      ['case', 'project_kickoff', 'package_session', 'retainer_checkin'] as const
    ).map((contextType, index) => ({
      meetingId: `m${index}`,
      scheduledStart: START,
      scheduledEnd: END,
      status: 'scheduled' as const,
      contextType,
      contextId: `engagement-${index}`,
      roomReady: true,
    }));

    const buckets = classifyCalendarContextIds(folded);

    expect(buckets.engagementIds).toEqual(
      new Set(['engagement-0', 'engagement-1', 'engagement-2', 'engagement-3'])
    );
    expect(buckets.projectDiscoveryIds.size).toBe(0);
    expect(buckets.requestInteractionIds.size).toBe(0);
  });

  it('buckets project_discovery separately from request_interaction', () => {
    const buckets = classifyCalendarContextIds([
      {
        meetingId: 'm1',
        scheduledStart: START,
        scheduledEnd: END,
        status: 'scheduled',
        contextType: 'project_discovery',
        contextId: 'request-1',
        roomReady: true,
      },
      {
        meetingId: 'm2',
        scheduledStart: START,
        scheduledEnd: END,
        status: 'scheduled',
        contextType: 'request_interaction',
        contextId: 'relationship-1',
        roomReady: true,
      },
    ]);

    expect(buckets.projectDiscoveryIds).toEqual(new Set(['request-1']));
    expect(buckets.requestInteractionIds).toEqual(new Set(['relationship-1']));
    expect(buckets.engagementIds.size).toBe(0);
  });

  it('de-duplicates repeated context ids across meetings into one Set entry', () => {
    const buckets = classifyCalendarContextIds([
      {
        meetingId: 'm1',
        scheduledStart: START,
        scheduledEnd: END,
        status: 'scheduled',
        contextType: 'case',
        contextId: 'engagement-1',
        roomReady: true,
      },
      {
        meetingId: 'm2',
        scheduledStart: START,
        scheduledEnd: END,
        status: 'scheduled',
        contextType: 'case',
        contextId: 'engagement-1',
        roomReady: true,
      },
    ]);

    expect(buckets.engagementIds).toEqual(new Set(['engagement-1']));
  });
});

const EMPTY_OWNERS = {
  engagementById: new Map(),
  projectDiscoveryById: new Map(),
  requestInteractionById: new Map(),
};

describe('assembleCalendarMeetings', () => {
  it('an engagement-grain meeting with a resolved owner carries engagementType + company, owningRowFound true', () => {
    const result = assembleCalendarMeetings(
      [
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'case',
          contextId: 'engagement-1',
          roomReady: true,
        },
      ],
      {
        ...EMPTY_OWNERS,
        engagementById: new Map([
          ['engagement-1', { id: 'engagement-1', engagementType: 'case', companyName: 'Acme Co' }],
        ]),
      },
      'expert-1'
    );

    expect(result).toEqual([
      {
        meetingId: 'm1',
        scheduledStart: START,
        scheduledEnd: END,
        status: 'scheduled',
        contextType: 'case',
        contextId: 'engagement-1',
        roomReady: true,
        engagementType: 'case',
        projectRequestId: null,
        counterpartyCompanyName: 'Acme Co',
        owningRowFound: true,
      },
    ]);
  });

  it('a project_discovery meeting resolves projectRequestId + company, engagementType stays null', () => {
    const result = assembleCalendarMeetings(
      [
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'project_discovery',
          contextId: 'request-1',
          roomReady: true,
        },
      ],
      {
        ...EMPTY_OWNERS,
        projectDiscoveryById: new Map([['request-1', { id: 'request-1', companyName: 'Globex' }]]),
      },
      'expert-1'
    );

    expect(result[0]).toMatchObject({
      engagementType: null,
      projectRequestId: 'request-1',
      counterpartyCompanyName: 'Globex',
      owningRowFound: true,
    });
  });

  it('a request_interaction meeting resolves the RELATIONSHIP-linked projectRequestId, not its own id', () => {
    const result = assembleCalendarMeetings(
      [
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'request_interaction',
          contextId: 'relationship-1',
          roomReady: true,
        },
      ],
      {
        ...EMPTY_OWNERS,
        requestInteractionById: new Map([
          [
            'relationship-1',
            { id: 'relationship-1', projectRequestId: 'request-9', companyName: 'Initech' },
          ],
        ]),
      },
      'expert-1'
    );

    expect(result[0]).toMatchObject({
      projectRequestId: 'request-9',
      counterpartyCompanyName: 'Initech',
      owningRowFound: true,
    });
  });

  it('a context id with NO resolved owner (drifted/forged/soft-deleted) fails CLOSED: owningRowFound false, every identity field null', () => {
    const result = assembleCalendarMeetings(
      [
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'case',
          contextId: 'engagement-does-not-resolve',
          roomReady: true,
        },
      ],
      EMPTY_OWNERS,
      'expert-1'
    );

    expect(result[0]).toMatchObject({
      engagementType: null,
      projectRequestId: null,
      counterpartyCompanyName: null,
      owningRowFound: false,
    });
    // R8 — `contextId` is nulled WITH its three siblings. It crosses a seam with no FK and no
    // RLS, so an unverified value is another tenant's `engagements.id`; emitting it beside three
    // deliberately-nulled fields handed every consumer of the exported `ExpertCalendarMeeting`
    // a cross-tenant identifier behind nothing but a docblock.
    expect(result[0]?.contextId).toBeNull();
  });

  it('a RESOLVED context still carries its contextId — the R8 null is fail-closed, not blanket', () => {
    const result = assembleCalendarMeetings(
      [
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'case',
          contextId: 'engagement-1',
          roomReady: true,
        },
      ],
      {
        ...EMPTY_OWNERS,
        engagementById: new Map([
          ['engagement-1', { id: 'engagement-1', engagementType: 'case', companyName: 'Acme Co' }],
        ]),
      },
      'expert-1'
    );

    expect(result[0]?.owningRowFound).toBe(true);
    expect(result[0]?.contextId).toBe('engagement-1');
  });

  it('package_session and retainer_checkin also resolve through the engagement-grain lookup', () => {
    const result = assembleCalendarMeetings(
      [
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'package_session',
          contextId: 'engagement-1',
          roomReady: true,
        },
        {
          meetingId: 'm2',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'retainer_checkin',
          contextId: 'engagement-1',
          roomReady: true,
        },
      ],
      {
        ...EMPTY_OWNERS,
        engagementById: new Map([
          [
            'engagement-1',
            { id: 'engagement-1', engagementType: 'package', companyName: 'Acme Co' },
          ],
        ]),
      },
      'expert-1'
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.owningRowFound).toBe(true);
    expect(result[1]?.owningRowFound).toBe(true);
  });

  /**
   * BAL-581 — `roomReady` is copied through per meeting, and is NOT an identity field: an
   * unresolved owner nulls `contextId` and its siblings (R8) but leaves the readiness boolean as
   * read, because it describes the meeting's own columns, not the polymorphic seam.
   */
  it('copies roomReady through per meeting, resolved owner or not', () => {
    const result = assembleCalendarMeetings(
      [
        {
          meetingId: 'm-ready',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'case',
          contextId: 'engagement-1',
          roomReady: true,
        },
        {
          meetingId: 'm-not-ready',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'case',
          contextId: 'engagement-1',
          roomReady: false,
        },
        {
          meetingId: 'm-unresolved-not-ready',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'case',
          contextId: 'engagement-does-not-resolve',
          roomReady: false,
        },
      ],
      {
        ...EMPTY_OWNERS,
        engagementById: new Map([
          ['engagement-1', { id: 'engagement-1', engagementType: 'case', companyName: 'Acme Co' }],
        ]),
      },
      'expert-1'
    );

    expect(result).toHaveLength(3);
    expect(result.map((row) => [row.meetingId, row.roomReady, row.owningRowFound])).toEqual([
      ['m-ready', true, true],
      ['m-not-ready', false, true],
      ['m-unresolved-not-ready', false, false],
    ]);
  });
});

/**
 * BAL-498 fix round 4, item 3 — the DEFAULT row cap is fail-closed.
 *
 * `.limit(rowLimit)` is applied AFTER `orderBy(asc(scheduledStart))`, so an over-limit read drops
 * the LATEST rows, not the oldest. A far-past `?week=` gives a `rangeStart` up to 371 days back
 * with `rangeEnd` clamped forward to `today + 28`, so the meetings truncated away would be TODAY'S
 * and the Agenda horizon's — the exact "You're all clear" -with-a-call-in-two-hours symptom the N5
 * clamp exists to prevent, reintroduced silently behind a `warn`. Throwing surfaces it instead.
 */
describe('assertCalendarRowCapNotExceeded — the default row cap throws rather than dropping the near future', () => {
  it('throws when the DEFAULT cap is reached, because the rows a LIMIT drops are the latest ones', () => {
    expect(() =>
      assertCalendarRowCapNotExceeded({
        rowCount: MAX_CALENDAR_ROWS,
        rowLimit: MAX_CALENDAR_ROWS,
        limitIsCallerSupplied: false,
        expertProfileId: 'expert-1',
      })
    ).toThrow(CalendarTooManyRowsError);
  });

  it('the thrown error names the expert and the cap, so the failure is actionable', () => {
    expect(() =>
      assertCalendarRowCapNotExceeded({
        rowCount: 2000,
        rowLimit: 2000,
        limitIsCallerSupplied: false,
        expertProfileId: 'expert-7',
      })
    ).toThrow(/expert-7 has at least 2000 context rows/);
  });

  it('does NOT throw below the cap — which is every real call', () => {
    expect(() =>
      assertCalendarRowCapNotExceeded({
        rowCount: MAX_CALENDAR_ROWS - 1,
        rowLimit: MAX_CALENDAR_ROWS,
        limitIsCallerSupplied: false,
        expertProfileId: 'expert-1',
      })
    ).not.toThrow();
  });

  it('an EXPLICIT caller-supplied limit is exempt — it opts into truncation, so the trailing-meeting fold-safety drop still governs there', () => {
    // Pins the integration case "caps the returned rows, and drops the trailing meeting whose
    // context set the LIMIT may have sliced (S2)": `limit: 1` must still return `[]`, not throw.
    expect(() =>
      assertCalendarRowCapNotExceeded({
        rowCount: 1,
        rowLimit: 1,
        limitIsCallerSupplied: true,
        expertProfileId: 'expert-1',
      })
    ).not.toThrow();
  });
});

/**
 * BAL-513 fix round 1, F3 — closes a coverage gap: nothing previously pinned
 * `MAX_CALENDAR_RANGE_DAYS` against the Agenda horizon it must stay wider than, so shrinking it to
 * 29-34 would silently break the expert calendar's Agenda window while every non-Docker gate
 * stayed green — the web suite only duplicated it as a bare `35` literal, and the failure would
 * have surfaced solely in `meetings.integration.test.ts` or in production.
 *
 * ⚠ `>= 31`, NOT `>= 28`. `apps/web/src/app/(dashboard)/expert/calendar/_lib/load-expert-calendar.ts`'s
 * `AGENDA_HORIZON_DAYS` is 28, but `meetings.integration.test.ts` shares an unnamed `RANGE`
 * literal spanning 30 days + 1 hour (30.04 days) across 11 tenant-isolation and
 * forged-polymorphic-context SECURITY tests — anything at or under that floor makes every one of
 * them throw, independent of the Agenda horizon. 31 clears BOTH floors with headroom.
 *
 * ⚠ WHY HERE, NOT ON THE WEB SIDE. `apps/web` cannot assert against the real constant:
 * `MAX_CALENDAR_RANGE_DAYS` is not part of `@balo/db`'s public surface
 * (`packages/db/src/repositories/index.ts` hand-picks its re-exports from `./meetings` and
 * omits it; `package.json`'s `exports` map exposes only `.` and `./schema`) — see
 * `load-expert-calendar.test.ts`'s docblock for the empirical check. This is the one place the
 * invariant is actually enforced.
 */
describe('MAX_CALENDAR_RANGE_DAYS', () => {
  it('stays at least 31 — above both the web Agenda horizon (28) and the integration RANGE floor (30.04)', () => {
    expect(MAX_CALENDAR_RANGE_DAYS).toBeGreaterThanOrEqual(31);
  });
});
