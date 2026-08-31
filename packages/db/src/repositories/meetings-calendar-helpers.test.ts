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
  foldMeetingContextRowsToPrimary,
  classifyCalendarContextIds,
  assembleCalendarMeetings,
  assertCalendarRowCapNotExceeded,
  CalendarTooManyRowsError,
  MAX_CALENDAR_ROWS,
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
        },
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'project_kickoff',
          contextId: 'engagement-1',
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
        },
        {
          meetingId: 'm1',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'project_kickoff',
          contextId: 'engagement-2',
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
        },
        {
          meetingId: 'm2',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'request_interaction',
          contextId: 'relationship-1',
        },
      ],
      'expert-1'
    );

    expect(folded.map((row) => row.meetingId)).toEqual(['m1', 'm2']);
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
      },
      {
        meetingId: 'm2',
        scheduledStart: START,
        scheduledEnd: END,
        status: 'scheduled',
        contextType: 'request_interaction',
        contextId: 'relationship-1',
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
      },
      {
        meetingId: 'm2',
        scheduledStart: START,
        scheduledEnd: END,
        status: 'scheduled',
        contextType: 'case',
        contextId: 'engagement-1',
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
        },
        {
          meetingId: 'm2',
          scheduledStart: START,
          scheduledEnd: END,
          status: 'scheduled',
          contextType: 'retainer_checkin',
          contextId: 'engagement-1',
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
