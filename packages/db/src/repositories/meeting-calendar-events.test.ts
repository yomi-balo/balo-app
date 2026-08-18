import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const DIALECT = new PgDialect();

// ── Hoisted mocks ────────────────────────────────────────────────

const {
  mockReturning,
  mockWhere,
  mockSet,
  mockValues,
  mockOnConflictDoUpdate,
  mockFindFirst,
  mockFindMany,
} = vi.hoisted(() => ({
  mockReturning: vi.fn(),
  mockWhere: vi.fn(),
  mockSet: vi.fn(),
  mockValues: vi.fn(),
  mockOnConflictDoUpdate: vi.fn(),
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock('../client', () => ({
  db: {
    query: {
      meetingCalendarEvents: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
    insert: (..._args: unknown[]) => ({
      values: (...vArgs: unknown[]) => {
        mockValues(...vArgs);
        return {
          onConflictDoUpdate: (...oArgs: unknown[]) => {
            mockOnConflictDoUpdate(...oArgs);
            return { returning: mockReturning };
          },
          returning: mockReturning,
        };
      },
    }),
    update: (..._args: unknown[]) => ({
      set: (...sArgs: unknown[]) => {
        mockSet(...sArgs);
        return {
          where: (...wArgs: unknown[]) => {
            mockWhere(...wArgs);
            return undefined;
          },
        };
      },
    }),
  },
}));

import { meetingCalendarEventsRepository } from './meeting-calendar-events';

const INPUT = {
  meetingId: 'meeting-1',
  connectionId: 'conn-1',
  calendarId: 'cal-work',
  vendorEventId: 'vendor-evt-1',
  baloBookingId: 'balo-booking-1',
};

/** Render a captured Drizzle condition to SQL text + params. */
function render(condition: unknown): { sql: string; params: unknown[] } {
  return DIALECT.sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]);
}

// ── Tests ──────────────────────────────────────────────────────

describe('meetingCalendarEventsRepository.record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the vendor answer verbatim and returns the row', async () => {
    const row = { id: 'mce-1', ...INPUT };
    mockReturning.mockReturnValue([row]);

    expect(await meetingCalendarEventsRepository.record(INPUT)).toEqual(row);
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining(INPUT));
  });

  /**
   * ⚠ THIS SUITE CANNOT PROVE THE ARBITER WORKS — the whole Drizzle client is mocked, so
   * `onConflictDoUpdate` records its argument and never reaches a planner. A missing
   * `targetWhere` against the PARTIAL `meeting_calendar_event_meeting_uq` raises 42P10 at
   * PLAN time (first call, empty table) with this file green. The behavioural proof is in
   * `meeting-calendar-events.integration.test.ts`; what is worth pinning here is the SHAPE.
   */
  it('arbits on meeting_id and restates the partial predicate as targetWhere', async () => {
    mockReturning.mockReturnValue([{ id: 'mce-1' }]);

    await meetingCalendarEventsRepository.record(INPUT);

    const [config] = mockOnConflictDoUpdate.mock.calls[0] as [
      { target: { name: string }[]; targetWhere?: unknown; set: Record<string, unknown> },
    ];
    expect(config.target.map((column) => column.name)).toEqual(['meeting_id']);
    expect(config.targetWhere).toBeDefined();
  });

  /**
   * ⚠ IDEMPOTENCY IS KEYED ON BALO'S MEETING ID, AND THE VENDOR ID IS A VALUE. A retry must
   * overwrite `vendor_event_id`, because Microsoft answers 200 to a caller-supplied id and
   * substitutes its own — so the second attempt can legitimately return a DIFFERENT id, and
   * the row must end up holding the one that actually exists at the provider.
   */
  it('overwrites the vendor id on retry, and never resurrects a soft-deleted row', async () => {
    mockReturning.mockReturnValue([{ id: 'mce-1' }]);

    await meetingCalendarEventsRepository.record(INPUT);

    const [config] = mockOnConflictDoUpdate.mock.calls[0] as [{ set: Record<string, unknown> }];
    expect(config.set).toMatchObject({
      vendorEventId: 'vendor-evt-1',
      calendarId: 'cal-work',
      connectionId: 'conn-1',
      baloBookingId: 'balo-booking-1',
    });
    // A rebook must INSERT beside the soft-deleted row, so the update arm must not clear
    // `deleted_at` — the only row it can reach is already live.
    expect(config.set).not.toHaveProperty('deletedAt');
  });
});

describe('meetingCalendarEventsRepository reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('findLiveByMeetingId scopes to the meeting and excludes soft-deleted rows', async () => {
    mockFindFirst.mockResolvedValue({ id: 'mce-1' });

    expect(await meetingCalendarEventsRepository.findLiveByMeetingId('meeting-1')).toEqual({
      id: 'mce-1',
    });

    const [args] = mockFindFirst.mock.calls[0] as [{ where: unknown }];
    const { sql, params } = render(args.where);
    expect(sql).toContain('"meeting_id"');
    expect(sql).toContain('"deleted_at" is null');
    expect(params).toContain('meeting-1');
  });

  it('findLiveByMeetingId answers undefined when Balo wrote no event', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    expect(await meetingCalendarEventsRepository.findLiveByMeetingId('meeting-x')).toBeUndefined();
  });

  it('listLiveByConnectionId scopes to the connection and orders deterministically', async () => {
    mockFindMany.mockResolvedValue([{ id: 'mce-1' }, { id: 'mce-2' }]);

    expect(await meetingCalendarEventsRepository.listLiveByConnectionId('conn-1')).toHaveLength(2);

    const [args] = mockFindMany.mock.calls[0] as [{ where: unknown; orderBy: unknown[] }];
    const { sql } = render(args.where);
    expect(sql).toContain('"connection_id"');
    expect(sql).toContain('"deleted_at" is null');
    // created_at alone is not a total order inside one transaction — `id` breaks the tie.
    expect(args.orderBy).toHaveLength(2);
  });
});

describe('meetingCalendarEventsRepository.softDeleteByMeetingId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks deletedAt rather than deleting, scoped to live rows for that meeting', async () => {
    mockWhere.mockResolvedValue(undefined);
    mockSet.mockReturnValue({ where: mockWhere });

    await meetingCalendarEventsRepository.softDeleteByMeetingId('meeting-1');

    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ deletedAt: expect.any(Date) }));
    const [condition] = mockWhere.mock.calls[0] ?? [];
    const { sql } = render(condition);
    expect(sql).toContain('"meeting_id"');
    expect(sql).toContain('"deleted_at" is null');
  });
});
