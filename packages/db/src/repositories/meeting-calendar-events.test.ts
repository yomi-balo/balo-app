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

const PROVIDER_INPUT = {
  meetingId: 'meeting-1',
  party: 'expert',
  connectionId: 'conn-1',
  calendarId: 'cal-work',
  vendorEventId: 'vendor-evt-1',
  baloBookingId: 'balo-booking-1',
} as const;

/** A row that satisfies the provider narrowing — all four provider columns present. */
const PROVIDER_ROW = {
  id: 'mce-1',
  meetingId: 'meeting-1',
  party: 'expert',
  deliveryMode: 'provider_event',
  connectionId: 'conn-1',
  calendarId: 'cal-work',
  vendorEventId: 'vendor-evt-1',
  baloBookingId: 'balo-booking-1',
  deletedAt: null,
};

/** Render a captured Drizzle condition to SQL text + params. */
function render(condition: unknown): { sql: string; params: unknown[] } {
  return DIALECT.sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]);
}

/** The single `onConflictDoUpdate` config the call under test captured. */
function conflictConfig(): {
  target: { name: string }[];
  targetWhere?: unknown;
  setWhere?: unknown;
  set: Record<string, unknown>;
} {
  const [config] = mockOnConflictDoUpdate.mock.calls[0] as [
    {
      target: { name: string }[];
      targetWhere?: unknown;
      setWhere?: unknown;
      set: Record<string, unknown>;
    },
  ];
  return config;
}

// ── Tests ──────────────────────────────────────────────────────

describe('meetingCalendarEventsRepository.recordProviderEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the vendor answer verbatim, tagged as a provider event, and returns the row', async () => {
    mockReturning.mockReturnValue([PROVIDER_ROW]);

    expect(await meetingCalendarEventsRepository.recordProviderEvent(PROVIDER_INPUT)).toEqual(
      PROVIDER_ROW
    );
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ ...PROVIDER_INPUT, deliveryMode: 'provider_event' })
    );
  });

  /**
   * ⚠ THIS SUITE CANNOT PROVE THE ARBITER WORKS — the whole Drizzle client is mocked, so
   * `onConflictDoUpdate` records its argument and never reaches a planner. A missing
   * `targetWhere` against the PARTIAL `meeting_calendar_event_meeting_party_uq` raises 42P10
   * at PLAN time (first call, empty table) with this file green. The behavioural proof is in
   * `meeting-calendar-events.integration.test.ts`; what is worth pinning here is the SHAPE.
   */
  it('arbits on (meeting_id, party) and restates the partial predicate as targetWhere', async () => {
    mockReturning.mockReturnValue([PROVIDER_ROW]);

    await meetingCalendarEventsRepository.recordProviderEvent(PROVIDER_INPUT);

    const config = conflictConfig();
    expect(config.target.map((column) => column.name)).toEqual(['meeting_id', 'party']);
    expect(config.targetWhere).toBeDefined();
    // ⚠ NO `setWhere` HERE, AND THAT ASYMMETRY IS DELIBERATE. `recordIcsDelivery` gates its
    // update arm because the `provider_event` → `ics` direction ORPHANS a vendor event; this
    // direction only ever ADDS an addressable one, so it must overwrite unconditionally.
    expect(config.setWhere).toBeUndefined();
  });

  /**
   * ⚠ IDEMPOTENCY IS KEYED ON BALO'S (MEETING, PARTY), AND THE VENDOR ID IS A VALUE. A retry
   * must overwrite `vendor_event_id`, because Microsoft answers 200 to a caller-supplied id
   * and substitutes its own — so the second attempt can legitimately return a DIFFERENT id,
   * and the row must end up holding the one that actually exists at the provider.
   */
  it('overwrites the full provider payload on retry, and never resurrects a soft-deleted row', async () => {
    mockReturning.mockReturnValue([PROVIDER_ROW]);

    await meetingCalendarEventsRepository.recordProviderEvent(PROVIDER_INPUT);

    expect(conflictConfig().set).toMatchObject({
      // The mode is restated so an `ics` row upgrading to a provider write ends up
      // consistent with the biconditional CHECK rather than raising 23514.
      deliveryMode: 'provider_event',
      vendorEventId: 'vendor-evt-1',
      calendarId: 'cal-work',
      connectionId: 'conn-1',
      baloBookingId: 'balo-booking-1',
    });
    // A rebook must INSERT beside the soft-deleted row, so the update arm must not clear
    // `deleted_at` — the only row it can reach is already live.
    expect(conflictConfig().set).not.toHaveProperty('deletedAt');
  });

  it('throws rather than answering an absent row', async () => {
    mockReturning.mockReturnValue([]);

    await expect(
      meetingCalendarEventsRepository.recordProviderEvent(PROVIDER_INPUT)
    ).rejects.toThrow(/provider calendar event/i);
  });
});

describe('meetingCalendarEventsRepository.recordIcsDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records the fallback CONDITION with no provider payload at all', async () => {
    const row = { id: 'mce-2', meetingId: 'meeting-1', party: 'expert', deliveryMode: 'ics' };
    mockReturning.mockReturnValue([row]);

    expect(
      await meetingCalendarEventsRepository.recordIcsDelivery({
        meetingId: 'meeting-1',
        party: 'expert',
      })
    ).toEqual(row);

    const [values] = mockValues.mock.calls[0] as [Record<string, unknown>];
    expect(values).toEqual({ meetingId: 'meeting-1', party: 'expert', deliveryMode: 'ics' });
  });

  /**
   * ⚠⚠ THE NULLS ARE LOAD-BEARING. A `provider_event` row transitioning to `ics` while
   * keeping a stale `vendor_event_id` violates `meeting_calendar_event_delivery_payload`
   * (23514) — and if it somehow did not, the row would claim an event Balo no longer wrote.
   */
  it('nulls all four provider columns in the DO UPDATE arm', async () => {
    mockReturning.mockReturnValue([{ id: 'mce-2' }]);

    await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: 'meeting-1',
      party: 'client',
    });

    const config = conflictConfig();
    expect(config.target.map((column) => column.name)).toEqual(['meeting_id', 'party']);
    expect(config.targetWhere).toBeDefined();
    expect(config.set).toMatchObject({
      deliveryMode: 'ics',
      connectionId: null,
      calendarId: null,
      vendorEventId: null,
      baloBookingId: null,
    });
    expect(config.set).not.toHaveProperty('deletedAt');
  });

  /**
   * ⚠⚠ THE ORPHAN GUARD, AS A SHAPE. Nulling the four provider columns on a row that names a
   * REAL vendor event destroys the only way to address it and deletes NOTHING at the provider
   * — the event lives on the expert's calendar for good. `setWhere` narrows the update arm to
   * rows that are ALREADY `ics`, so a live `provider_event` row updates nothing and the call
   * throws instead. (Unreachable from today's single caller; reachable from BAL-475/476.)
   */
  it('gates the DO UPDATE arm on the existing row already being ics (the orphan guard)', async () => {
    mockReturning.mockReturnValue([{ id: 'mce-2' }]);

    await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: 'meeting-1',
      party: 'expert',
    });

    const { sql, params } = render(conflictConfig().setWhere);
    expect(sql).toContain('"delivery_mode"');
    expect(params).toContain('ics');
  });

  /**
   * Zero returned rows has exactly ONE cause once `setWhere` is in place: the insert
   * conflicted and the update was refused. The message must say so — "failed to record"
   * would send the next reader looking for a database fault.
   */
  it('throws, naming the refusal, when the update arm matches nothing', async () => {
    mockReturning.mockReturnValue([]);

    await expect(
      meetingCalendarEventsRepository.recordIcsDelivery({
        meetingId: 'meeting-1',
        party: 'expert',
      })
    ).rejects.toThrow(/ICS calendar delivery/i);
    await expect(
      meetingCalendarEventsRepository.recordIcsDelivery({
        meetingId: 'meeting-1',
        party: 'expert',
      })
    ).rejects.toThrow(/provider_event/);
  });
});

describe('meetingCalendarEventsRepository reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * ⚠ THE THREE FILTERS ARE THE WHOLE POINT OF THE RENAME. `hasVendorEvent` feeds the
   * availability exclusion in three reschedule routes; an ICS-fallback row (or a client-party
   * row) answering "yes" would drop a real busy block and let the expert be double-booked.
   */
  it('findLiveExpertProviderEvent scopes to the expert PROVIDER row and excludes soft-deleted rows', async () => {
    mockFindFirst.mockResolvedValue(PROVIDER_ROW);

    expect(await meetingCalendarEventsRepository.findLiveExpertProviderEvent('meeting-1')).toEqual(
      PROVIDER_ROW
    );

    const [args] = mockFindFirst.mock.calls[0] as [{ where: unknown }];
    const { sql, params } = render(args.where);
    expect(sql).toContain('"meeting_id"');
    expect(sql).toContain('"party"');
    expect(sql).toContain('"delivery_mode"');
    expect(sql).toContain('"deleted_at" is null');
    expect(params).toContain('meeting-1');
    expect(params).toContain('expert');
    expect(params).toContain('provider_event');
  });

  it('findLiveExpertProviderEvent answers undefined when Balo wrote no vendor event', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    expect(
      await meetingCalendarEventsRepository.findLiveExpertProviderEvent('meeting-x')
    ).toBeUndefined();
  });

  /**
   * Unreachable under the biconditional CHECK — asserted anyway because the narrowed row type
   * promises four non-null columns and the guard is what earns that promise (no `!`, no `as`).
   */
  it('findLiveExpertProviderEvent drops a row that fails the provider narrowing', async () => {
    mockFindFirst.mockResolvedValue({ ...PROVIDER_ROW, vendorEventId: null });

    expect(
      await meetingCalendarEventsRepository.findLiveExpertProviderEvent('meeting-1')
    ).toBeUndefined();
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

describe('meetingCalendarEventsRepository.softDeleteByMeetingAndParty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks deletedAt rather than deleting, scoped to the live row for THAT party', async () => {
    await meetingCalendarEventsRepository.softDeleteByMeetingAndParty('meeting-1', 'expert');

    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ deletedAt: expect.any(Date) }));
    const [condition] = mockWhere.mock.calls[0] ?? [];
    const { sql, params } = render(condition);
    expect(sql).toContain('"meeting_id"');
    // ⚠ PARTY-SCOPED: a vendor 404 on the expert's event must not soft-delete a client row.
    expect(sql).toContain('"party"');
    expect(sql).toContain('"deleted_at" is null');
    expect(params).toContain('expert');
  });
});
