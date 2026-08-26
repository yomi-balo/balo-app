import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { ProvisionedRoom, RoomProvisioner } from '../daily/rooms.js';

const {
  mockFindById,
  mockSetVenue,
  mockBookMeeting,
  mockTrackServer,
  mockFindByBookingIdempotencyKey,
  mockFindWithContexts,
  mockProjectBookingCalendarEvent,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockSetVenue: vi.fn(),
  mockBookMeeting: vi.fn(),
  mockTrackServer: vi.fn(),
  mockFindByBookingIdempotencyKey: vi.fn(),
  mockFindWithContexts: vi.fn(),
  mockProjectBookingCalendarEvent: vi.fn(),
}));

/**
 * ⚠ BAL-433 MOVED FIVE REPOSITORY MOCKS OUT OF THIS FILE. `caseEngagementsRepository`,
 * `companiesRepository`, `engagementsRepository`, `projectRequestsRepository` and
 * `requestExpertRelationshipsRepository` were mocked here because the per-context calendar
 * RESOLVERS lived in `provision-meeting.ts`. They now live in
 * `services/consultation-events/resolve-calendar-facts.ts`, and their behaviour is proved in
 * `resolve-calendar-facts.test.ts` — not here, mocked, one layer away from the code under test.
 * A vitest factory mock throws on any export the module imports and it omits, so this literal
 * is a live statement of what `provision-meeting.ts` actually reaches.
 */
vi.mock('@balo/db', () => ({
  meetingsRepository: {
    findById: mockFindById,
    setVenue: mockSetVenue,
    findByBookingIdempotencyKey: mockFindByBookingIdempotencyKey,
    findWithContexts: mockFindWithContexts,
  },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  MEETING_SERVER_EVENTS: {
    MEETING_PROVISIONED: 'meeting_provisioned',
    MEETING_PROVISION_FAILED: 'meeting_provision_failed',
    // ⚠ THE LITERAL IS THE TRAP. This mock replaces the real constants object, so a key
    // missing here makes the emit read `undefined` and the event is silently attributed to
    // nothing — with every other assertion in the file still green.
    MEETING_CALENDAR_PROJECTED: 'meeting_calendar_projected',
  },
}));
vi.mock('./meeting-availability.js', () => ({ bookMeeting: mockBookMeeting }));
vi.mock('../consultation-events/booking-calendar-projection.js', () => ({
  projectBookingCalendarEvent: mockProjectBookingCalendarEvent,
}));
// `@balo/shared/meetings` is deliberately NOT mocked — the real `dailyRoomNameForMeeting` is
// the arbiter the whole idempotency argument rests on, so the tests must see the real name.

// The REAL error class — `instanceof` is what decides whether the vendor's response body
// reaches the log, so a local stand-in would make that assertion vacuous.
import { DailyApiError } from '../daily/errors.js';
// ⚠ THE REAL TUPLE, NEVER A LOCAL LIST. A sixth bookable label must show up in the
// no-context-is-skipped sweep below rather than being quietly absent from a hand-copied array.
import { BOOKABLE_CONTEXT_TYPES } from '@balo/shared/meetings';
import {
  bookAndProvisionMeeting,
  provisionMeeting,
  BookingIdempotencyKeyConflictError,
  type BookAndProvisionInput,
} from './provision-meeting.js';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const ROOM_NAME = 'balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d';
const JOIN_URL = `https://balo.daily.co/${ROOM_NAME}`;
const CONTEXT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';

const NOW = new Date('2026-09-07T00:00:00.000Z');
const START = new Date('2026-09-07T09:00:00.000Z');
const END = new Date('2026-09-07T10:00:00.000Z');

const log = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as FastifyBaseLogger;

/** A live meeting row with no venue stamped yet. */
function unstampedMeeting(): Record<string, unknown> {
  return {
    id: MEETING_ID,
    scheduledStart: START,
    scheduledEnd: END,
    dailyRoomName: null,
    joinUrl: null,
  };
}

/**
 * The port's exact signature, so the fakes below SATISFY `RoomProvisioner` rather than
 * merely resembling it. A bare `vi.fn()` infers `Mock<Procedure | Constructable>`, which is
 * not assignable to the port — and an `as` cast would hide a real drift if the port changed.
 */
type CreateRoomFn = (name: string) => Promise<ProvisionedRoom>;

/** A provisioner that records its calls and succeeds. */
function fakeProvisioner(): RoomProvisioner & { createRoom: Mock<CreateRoomFn> } {
  return {
    createRoom: vi.fn<CreateRoomFn>(async (name: string) => ({
      dailyRoomName: name,
      joinUrl: `https://balo.daily.co/${name}`,
    })),
  };
}

/** A provisioner whose vendor call always fails. */
function throwingProvisioner(error: Error): RoomProvisioner & { createRoom: Mock<CreateRoomFn> } {
  return { createRoom: vi.fn<CreateRoomFn>().mockRejectedValue(error) };
}

const CASE_CONTEXT = {
  contextType: 'case',
  engagementType: 'case',
  userId: USER_ID,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockSetVenue.mockResolvedValue(unstampedMeeting());
  mockBookMeeting.mockResolvedValue({
    meeting: unstampedMeeting(),
    contexts: [],
    expertProfileId: 'expert_1',
  });
  mockProjectBookingCalendarEvent.mockResolvedValue('provider_event');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bookAndProvisionMeeting — the ordering', () => {
  it('books, THEN derives the room from the returned id, THEN stamps the venue', async () => {
    // The order is forced: the room name is keyed on `meetings.id`, which does not exist
    // until the insert returns.
    const order: string[] = [];
    mockBookMeeting.mockImplementation(async () => {
      order.push('book');
      return { meeting: unstampedMeeting(), contexts: [], expertProfileId: 'expert_1' };
    });
    const provisioner = {
      createRoom: vi.fn<CreateRoomFn>(async (name: string) => {
        order.push('createRoom');
        return { dailyRoomName: name, joinUrl: JOIN_URL };
      }),
    };
    mockSetVenue.mockImplementation(async () => {
      order.push('setVenue');
      return unstampedMeeting();
    });

    const result = await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: CONTEXT_ID,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: USER_ID,
      },
      log,
      { provisioner }
    );

    expect(order).toEqual(['book', 'createRoom', 'setVenue']);
    expect(provisioner.createRoom).toHaveBeenCalledWith(ROOM_NAME);
    expect(mockSetVenue).toHaveBeenCalledWith(MEETING_ID, {
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });
    expect(result).toMatchObject({
      provisioned: true,
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });
  });

  it('passes EXACTLY ONE context to bookMeeting', async () => {
    // `create` books; `attach` tags. A booking never writes a second context row.
    await bookAndProvisionMeeting(
      {
        contextType: 'project_kickoff',
        contextId: CONTEXT_ID,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'project',
        userId: USER_ID,
      },
      log,
      { provisioner: fakeProvisioner() }
    );

    expect(mockBookMeeting).toHaveBeenCalledWith(
      {
        scheduledStart: START,
        scheduledEnd: END,
        contexts: [{ contextType: 'project_kickoff', contextId: CONTEXT_ID }],
        actorUserId: USER_ID,
        // BAL-400 — `null` when the caller passed no `bookingIdempotencyKey` (this route's
        // three non-`case` context types don't mint one).
        bookingIdempotencyKey: null,
      },
      log
    );
  });

  it('passes the AUTHENTICATED user to bookMeeting as actorUserId (ADR-1044 §5)', async () => {
    // ⚠ THE POINT IS THAT `userId` REACHES A DATABASE WRITE, not just telemetry. Before
    // BAL-129 closed this, the route's authenticated user was spent entirely on PostHog's
    // `distinct_id` and the Pino log — and `trackServer` is a SILENT NO-OP without
    // `POSTHOG_API_KEY`, so on a deployment without analytics a committed booking named
    // nobody in any durable store. `create` folds this value into a `meeting.booked` audit
    // row on the booking's own transaction.
    //
    // Asserted on the `bookMeeting` INPUT rather than by spying on analytics precisely so
    // this test keeps passing for the right reason if the analytics call is ever removed.
    await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: CONTEXT_ID,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: USER_ID,
      },
      log,
      { provisioner: fakeProvisioner() }
    );

    const [bookInput] = mockBookMeeting.mock.calls[0] ?? [];
    expect((bookInput as { actorUserId: unknown }).actorUserId).toBe(USER_ID);
  });

  it('propagates the repository’s TYPED errors unwrapped — the route maps each one', async () => {
    // Catching here would flatten six branchable reasons into one 500.
    class MatchModeDiscoveryNotBookableError extends Error {
      constructor() {
        super('match mode');
        this.name = 'MatchModeDiscoveryNotBookableError';
      }
    }
    const thrown = new MatchModeDiscoveryNotBookableError();
    mockBookMeeting.mockRejectedValue(thrown);

    await expect(
      bookAndProvisionMeeting(
        {
          contextType: 'project_discovery',
          contextId: CONTEXT_ID,
          scheduledStart: START,
          scheduledEnd: END,
          engagementType: null,
          userId: USER_ID,
        },
        log
      )
    ).rejects.toBe(thrown);
  });
});

describe('bookAndProvisionMeeting — a vendor failure COMMITS the booking', () => {
  it('returns the meeting with provisioned:false and never calls setVenue', async () => {
    const provisioner = throwingProvisioner(new Error('Daily is down'));

    const result = await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: CONTEXT_ID,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: USER_ID,
      },
      log,
      { provisioner }
    );

    // The booking STANDS — a success with a missing artefact, not a failure.
    expect(result.meeting.id).toBe(MEETING_ID);
    expect(result).toMatchObject({ provisioned: false, dailyRoomName: null, joinUrl: null });
    expect(mockSetVenue).not.toHaveBeenCalled();
  });

  it('logs the failure WITH the meetingId — that is what makes the repair actionable', async () => {
    const provisioner = throwingProvisioner(new Error('Daily is down'));

    await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: CONTEXT_ID,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: USER_ID,
      },
      log,
      { provisioner }
    );

    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, contextType: 'case' }),
      'Meeting booked but Daily room provisioning failed'
    );
  });

  it('LOGS the vendor’s raw response body as its own field — the only place it is ever read', async () => {
    /**
     * ⚠ THE REGRESSION THIS PINS. `DailyApiError`'s docblock says the raw response text is
     * "FOR THE SERVER LOG ONLY", but nothing logged it: the catch recorded only
     * `name`/`message`/`stack`, and the message is `Daily API error: POST /rooms responded
     * 503` — it deliberately EXCLUDES the body. So the vendor's own explanation ("room name
     * already taken", an invalid-domain message, a quota message) was captured NOWHERE, which
     * weakened the very repair path the log exists for.
     */
    const provisioner = throwingProvisioner(
      new DailyApiError('POST', '/rooms', 503, '{"error":"quota-exceeded"}')
    );

    await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: CONTEXT_ID,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: USER_ID,
      },
      log,
      { provisioner }
    );

    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        errorName: 'DailyApiError',
        vendorBody: '{"error":"quota-exceeded"}',
      }),
      'Meeting booked but Daily room provisioning failed'
    );
    // ⚠ AND IT STAYS OUT OF ANALYTICS. `reason` is the error CLASS; the body can carry vendor
    // detail and must not ride into PostHog (nor into any response — §6.3's no-echo rule).
    expect(mockTrackServer).toHaveBeenCalledWith(
      'meeting_provision_failed',
      expect.objectContaining({ reason: 'DailyApiError' })
    );
    const [, failedProps] = mockTrackServer.mock.calls.find(
      ([event]) => event === 'meeting_provision_failed'
    ) as [string, Record<string, unknown>];
    expect(failedProps).not.toHaveProperty('vendorBody');
    expect(JSON.stringify(failedProps)).not.toContain('quota-exceeded');
  });

  it('omits vendorBody entirely for a non-vendor error', async () => {
    // A plain `Error` has no body to report, and `undefined` keeps the log line clean rather
    // than asserting a field that does not exist.
    const provisioner = throwingProvisioner(new Error('Daily is down'));

    await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: CONTEXT_ID,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: USER_ID,
      },
      log,
      { provisioner }
    );

    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.objectContaining({ vendorBody: undefined }),
      'Meeting booked but Daily room provisioning failed'
    );
  });

  it('emits meeting_provision_failed carrying the error CLASS, never its message', async () => {
    // §3.2 makes a vendor failure a 201, so without this event the failure is invisible to
    // product analytics and appears only in logs.
    class DailyApiError extends Error {
      constructor() {
        super('Daily API error: POST /rooms responded 503 — secret-bearing detail');
        this.name = 'DailyApiError';
      }
    }
    const provisioner = throwingProvisioner(new DailyApiError());

    await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: CONTEXT_ID,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: USER_ID,
      },
      log,
      { provisioner }
    );

    expect(mockTrackServer).toHaveBeenCalledWith('meeting_provision_failed', {
      meeting_id: MEETING_ID,
      context_type: 'case',
      engagement_type: 'case',
      reason: 'DailyApiError',
      distinct_id: USER_ID,
    });
    expect(mockTrackServer).not.toHaveBeenCalledWith('meeting_provisioned', expect.anything());
  });
});

describe('bookAndProvisionMeeting — the meeting_provisioned event (D4)', () => {
  it('reports duration, lead time and a NON-replay on the happy path', async () => {
    await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: CONTEXT_ID,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: USER_ID,
      },
      log,
      { provisioner: fakeProvisioner() }
    );

    expect(mockTrackServer).toHaveBeenCalledWith('meeting_provisioned', {
      meeting_id: MEETING_ID,
      context_type: 'case',
      engagement_type: 'case',
      duration_minutes: 60,
      lead_time_minutes: 540, // NOW 00:00 → start 09:00
      idempotent_replay: false,
      distinct_id: USER_ID,
    });
  });

  it('reports engagement_type: null for project_discovery — never a fabricated value', async () => {
    await bookAndProvisionMeeting(
      {
        contextType: 'project_discovery',
        contextId: CONTEXT_ID,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: null,
        userId: USER_ID,
      },
      log,
      { provisioner: fakeProvisioner() }
    );

    expect(mockTrackServer).toHaveBeenCalledWith(
      'meeting_provisioned',
      expect.objectContaining({ context_type: 'project_discovery', engagement_type: null })
    );
  });

  it.each([
    { contextType: 'project_kickoff', engagementType: 'project' },
    { contextType: 'package_session', engagementType: 'package' },
  ] as const)(
    'reports engagement_type "$engagementType" for $contextType',
    async ({ contextType, engagementType }) => {
      await bookAndProvisionMeeting(
        {
          contextType,
          contextId: CONTEXT_ID,
          scheduledStart: START,
          scheduledEnd: END,
          engagementType,
          userId: USER_ID,
        },
        log,
        { provisioner: fakeProvisioner() }
      );

      expect(mockTrackServer).toHaveBeenCalledWith(
        'meeting_provisioned',
        expect.objectContaining({ context_type: contextType, engagement_type: engagementType })
      );
    }
  );
});

describe('provisionMeeting — idempotency (D2, AC #6)', () => {
  it('REPLAY: an already-stamped meeting makes ZERO createRoom and ZERO setVenue calls', async () => {
    mockFindById.mockResolvedValue({
      ...unstampedMeeting(),
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });
    const provisioner = fakeProvisioner();

    const result = await provisionMeeting(MEETING_ID, CASE_CONTEXT, log, { provisioner });

    expect(result).toEqual({
      meetingId: MEETING_ID,
      provisioned: true,
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
      replayed: true,
    });
    expect(provisioner.createRoom).not.toHaveBeenCalled();
    expect(mockSetVenue).not.toHaveBeenCalled();
  });

  it('reports idempotent_replay: true on a replay', async () => {
    mockFindById.mockResolvedValue({
      ...unstampedMeeting(),
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });

    await provisionMeeting(MEETING_ID, CASE_CONTEXT, log, { provisioner: fakeProvisioner() });

    expect(mockTrackServer).toHaveBeenCalledWith(
      'meeting_provisioned',
      expect.objectContaining({ idempotent_replay: true })
    );
  });

  it('provisions when the venue is unstamped', async () => {
    mockFindById.mockResolvedValue(unstampedMeeting());
    const provisioner = fakeProvisioner();

    const result = await provisionMeeting(MEETING_ID, CASE_CONTEXT, log, { provisioner });

    expect(provisioner.createRoom).toHaveBeenCalledWith(ROOM_NAME);
    expect(result).toEqual({
      meetingId: MEETING_ID,
      provisioned: true,
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
      replayed: false,
    });
  });

  it.each([
    { label: 'only the room name', dailyRoomName: ROOM_NAME, joinUrl: null },
    { label: 'only the join url', dailyRoomName: null, joinUrl: JOIN_URL },
  ])('treats a half-stamped row ($label) as unprovisioned and re-provisions', async (venue) => {
    // `setVenue` writes both together, so this is not producible through the seam — but
    // treating it as unprovisioned is the FAIL-SAFE reading, and re-provisioning is harmless
    // because the already-exists branch finds the existing room.
    mockFindById.mockResolvedValue({ ...unstampedMeeting(), ...venue });
    const provisioner = fakeProvisioner();

    await provisionMeeting(MEETING_ID, CASE_CONTEXT, log, { provisioner });

    expect(provisioner.createRoom).toHaveBeenCalledWith(ROOM_NAME);
  });

  it('returns undefined for a missing or soft-deleted meeting', async () => {
    mockFindById.mockResolvedValue(undefined);

    await expect(provisionMeeting(MEETING_ID, CASE_CONTEXT, log)).resolves.toBeUndefined();
    expect(mockSetVenue).not.toHaveBeenCalled();
  });

  it('a vendor failure on the repair path returns provisioned:false rather than throwing', async () => {
    mockFindById.mockResolvedValue(unstampedMeeting());
    const provisioner = throwingProvisioner(new Error('Daily is down'));

    await expect(provisionMeeting(MEETING_ID, CASE_CONTEXT, log, { provisioner })).resolves.toEqual(
      {
        meetingId: MEETING_ID,
        provisioned: false,
        dailyRoomName: null,
        joinUrl: null,
        replayed: false,
      }
    );
  });
});

describe('bookAndProvisionMeeting — idempotent replay (BAL-400 Decision 7)', () => {
  const KEY = 'a'.repeat(64);

  function bookInput(overrides: Partial<BookAndProvisionInput> = {}): BookAndProvisionInput {
    return {
      contextType: 'case',
      contextId: CONTEXT_ID,
      scheduledStart: START,
      scheduledEnd: END,
      engagementType: 'case',
      userId: USER_ID,
      bookingIdempotencyKey: KEY,
      ...overrides,
    };
  }

  it('a key with no existing meeting creates normally and threads the key into bookMeeting', async () => {
    mockFindByBookingIdempotencyKey.mockResolvedValue(undefined);

    await bookAndProvisionMeeting(bookInput(), log, { provisioner: fakeProvisioner() });

    expect(mockBookMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ bookingIdempotencyKey: KEY }),
      log
    );
  });

  it('a key resolving to a COHERENT existing meeting replays through provisionMeeting, not bookMeeting', async () => {
    mockFindByBookingIdempotencyKey.mockResolvedValue({
      ...unstampedMeeting(),
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });
    mockFindWithContexts.mockResolvedValue({
      meeting: unstampedMeeting(),
      contexts: [{ contextType: 'case', contextId: CONTEXT_ID }],
    });
    // `provisionMeeting` (the replay path) re-reads the meeting itself via `findById`.
    mockFindById.mockResolvedValue({
      ...unstampedMeeting(),
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });

    const result = await bookAndProvisionMeeting(bookInput(), log, {
      provisioner: fakeProvisioner(),
    });

    expect(mockBookMeeting).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provisioned: true,
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });
    expect(result.meeting.id).toBe(MEETING_ID);
  });

  it('a key resolving to a meeting booked against a DIFFERENT context throws BookingIdempotencyKeyConflictError', async () => {
    mockFindByBookingIdempotencyKey.mockResolvedValue(unstampedMeeting());
    mockFindWithContexts.mockResolvedValue({
      meeting: unstampedMeeting(),
      contexts: [{ contextType: 'case', contextId: 'a-totally-different-case-id' }],
    });

    await expect(
      bookAndProvisionMeeting(bookInput(), log, { provisioner: fakeProvisioner() })
    ).rejects.toBeInstanceOf(BookingIdempotencyKeyConflictError);
    expect(mockBookMeeting).not.toHaveBeenCalled();
  });

  // ── S3 (second defect) — the WINDOW is part of "the same booking" ─────────
  //
  // The replay used to compare `contextType`/`contextId` and nothing else, so a key spent on
  // 15:00 silently resolved a 16:00 submit to the 15:00 meeting — and the client was then told
  // 16:00. The chosen semantics are CONFLICT, not silent-replay: see `lookupBookingReplay`.

  it.each([
    {
      label: 'a LATER start',
      existing: { scheduledStart: new Date(START.getTime() + 3_600_000), scheduledEnd: END },
    },
    {
      label: 'a different END only',
      existing: { scheduledStart: START, scheduledEnd: new Date(END.getTime() + 900_000) },
    },
  ])(
    'a key resolving to a meeting in a DIFFERENT WINDOW ($label) throws BookingIdempotencyKeyConflictError',
    async ({ existing }) => {
      mockFindByBookingIdempotencyKey.mockResolvedValue({ ...unstampedMeeting(), ...existing });
      mockFindWithContexts.mockResolvedValue({
        meeting: unstampedMeeting(),
        contexts: [{ contextType: 'case', contextId: CONTEXT_ID }],
      });

      await expect(
        bookAndProvisionMeeting(bookInput(), log, { provisioner: fakeProvisioner() })
      ).rejects.toBeInstanceOf(BookingIdempotencyKeyConflictError);
      expect(mockBookMeeting).not.toHaveBeenCalled();
      // The window is compared BEFORE the second read, so a mismatch costs no context lookup.
      expect(mockFindWithContexts).not.toHaveBeenCalled();
    }
  );

  it('an IDENTICAL window replays (the comparison is on the instant, not the object)', async () => {
    // Distinct `Date` objects carrying the same instant — a naive `!==` would 409 here.
    mockFindByBookingIdempotencyKey.mockResolvedValue({
      ...unstampedMeeting(),
      scheduledStart: new Date(START.getTime()),
      scheduledEnd: new Date(END.getTime()),
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });
    mockFindWithContexts.mockResolvedValue({
      meeting: unstampedMeeting(),
      contexts: [{ contextType: 'case', contextId: CONTEXT_ID }],
    });
    mockFindById.mockResolvedValue({
      ...unstampedMeeting(),
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });

    const result = await bookAndProvisionMeeting(bookInput(), log, {
      provisioner: fakeProvisioner(),
    });

    expect(mockBookMeeting).not.toHaveBeenCalled();
    expect(result.meeting.id).toBe(MEETING_ID);
  });

  it('a concurrent double-submit (23505 on create) re-reads by key and replays rather than throwing raw', async () => {
    mockFindByBookingIdempotencyKey
      .mockResolvedValueOnce(undefined) // first check: nothing yet
      .mockResolvedValueOnce({
        ...unstampedMeeting(),
        dailyRoomName: ROOM_NAME,
        joinUrl: JOIN_URL,
      }); // re-read after the race
    mockFindWithContexts.mockResolvedValue({
      meeting: unstampedMeeting(),
      contexts: [{ contextType: 'case', contextId: CONTEXT_ID }],
    });
    mockFindById.mockResolvedValue({
      ...unstampedMeeting(),
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });
    const conflict = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockBookMeeting.mockRejectedValue(conflict);

    const result = await bookAndProvisionMeeting(bookInput(), log, {
      provisioner: fakeProvisioner(),
    });

    expect(result).toMatchObject({
      provisioned: true,
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
    });
  });

  it('a non-unique-violation create failure is NOT swallowed, even with a key present', async () => {
    mockFindByBookingIdempotencyKey.mockResolvedValue(undefined);
    const notAConflict = new Error('something else broke');
    mockBookMeeting.mockRejectedValue(notAConflict);

    await expect(
      bookAndProvisionMeeting(bookInput(), log, { provisioner: fakeProvisioner() })
    ).rejects.toBe(notAConflict);
  });

  it('no key at all never touches findByBookingIdempotencyKey', async () => {
    await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: CONTEXT_ID,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: USER_ID,
      },
      log,
      { provisioner: fakeProvisioner() }
    );

    expect(mockFindByBookingIdempotencyKey).not.toHaveBeenCalled();
  });
});

/**
 * BAL-400 (D2) / BAL-283 / BAL-433 — THE PROJECTION CALL, AND ONLY THE CALL.
 *
 * ⚠ WHAT THIS FILE DELIBERATELY NO LONGER TESTS. Until BAL-433 this suite reached through the
 * projection into the per-context RESOLVERS (case → company; relationship → request → company)
 * because those lived in `provision-meeting.ts`. They now live in
 * `services/consultation-events/resolve-calendar-facts.ts` and are proved there, against the
 * real `resolveContextOwner`. Re-asserting them here through two mocks would be a second,
 * weaker copy of that suite — and it is precisely the copy that would keep passing after the
 * real resolver broke.
 *
 * What is left is this module's own obligation: it calls the projection for EVERY bookable
 * context, exactly once, on a fresh create only, and it reports the outcome.
 */
describe('bookAndProvisionMeeting — the expert calendar projection (BAL-433)', () => {
  function bookInput(
    contextType: BookAndProvisionInput['contextType'],
    overrides: Partial<BookAndProvisionInput> = {}
  ): BookAndProvisionInput {
    return {
      contextType,
      contextId: CONTEXT_ID,
      scheduledStart: START,
      scheduledEnd: END,
      engagementType: 'case',
      userId: USER_ID,
      ...overrides,
    };
  }

  /**
   * ⚠⚠ ALL FIVE, PARAMETRISED — THIS IS THE SLICE-1 HEADLINE ASSERTION AT THE UNIT LEVEL.
   * Three of these five (`project_kickoff`, `package_session`, `project_discovery`) have NO
   * production booking producer on `main`, so this direct service call is the only place their
   * arm runs at all. Before BAL-433 they reached no calendar: the expert held a real, confirmed
   * Balo meeting that was absent from their own calendar, and because Balo READS their external
   * free/busy, a colleague could book over it with nothing on either side detecting it.
   */
  it.each([
    'case',
    'project_kickoff',
    'package_session',
    'project_discovery',
    'request_interaction',
  ] as const)(
    'projects the booking for contextType "%s" — every bookable context',
    async (contextType) => {
      await bookAndProvisionMeeting(bookInput(contextType), log, {
        provisioner: fakeProvisioner(),
      });

      expect(mockProjectBookingCalendarEvent).toHaveBeenCalledTimes(1);
      expect(mockProjectBookingCalendarEvent).toHaveBeenCalledWith(
        expect.objectContaining({ expertProfileId: 'expert_1' }),
        contextType,
        CONTEXT_ID,
        log
      );
    }
  );

  it('hands the projection the CREATED meeting, so the window and id come from the commit', async () => {
    await bookAndProvisionMeeting(bookInput('case'), log, { provisioner: fakeProvisioner() });

    const [[created]] = mockProjectBookingCalendarEvent.mock.calls;
    expect((created as { meeting: { id: string } }).meeting.id).toBe(MEETING_ID);
  });

  /**
   * ⚠ NO GATE IS LEFT. `isCalendarProjectedContext` is gone; exhaustiveness is the registry's
   * `Record` and a sixth bookable label fails `tsc` there. This asserts the absence of the
   * gate BEHAVIOURALLY: nothing this module does may make a context reach no calendar.
   */
  it('⚠ no context is skipped — the count matches BOOKABLE_CONTEXT_TYPES exactly', async () => {
    for (const contextType of BOOKABLE_CONTEXT_TYPES) {
      mockProjectBookingCalendarEvent.mockClear();
      await bookAndProvisionMeeting(bookInput(contextType), log, {
        provisioner: fakeProvisioner(),
      });
      expect(
        mockProjectBookingCalendarEvent,
        `${contextType} reached no calendar`
      ).toHaveBeenCalledTimes(1);
    }
    expect(BOOKABLE_CONTEXT_TYPES.length).toBe(5);
  });

  it.each(['provider_event', 'ics', 'skipped', 'failed'] as const)(
    'emits meeting_calendar_projected with delivery "%s", verbatim from the projection',
    async (delivery) => {
      mockProjectBookingCalendarEvent.mockResolvedValue(delivery);

      await bookAndProvisionMeeting(bookInput('case'), log, { provisioner: fakeProvisioner() });

      expect(mockTrackServer).toHaveBeenCalledWith('meeting_calendar_projected', {
        meeting_id: MEETING_ID,
        context_type: 'case',
        // Slice 1 writes the expert side only — `calendar_connections` is keyed on
        // `expert_profile_id` and no client-side connection model exists.
        party: 'expert',
        delivery,
        distinct_id: USER_ID,
      });
    }
  );

  it('a throwing projection call does NOT fail the booking, and still reports an outcome', async () => {
    // `projectBookingCalendarEvent`'s own contract is "never throws" (D2c) — but the CALL SITE
    // wraps it in a try/catch too, defence-in-depth, so a violation of that contract still
    // cannot turn a COMMITTED booking into a rejected promise. `POST /meetings` maps an
    // unrecognised throw to a 500, and this module's header is explicit that telling the client
    // "this failed" about a booking that exists is the worst of the available outcomes.
    mockProjectBookingCalendarEvent.mockRejectedValue(new Error('should never happen'));

    const result = await bookAndProvisionMeeting(bookInput('case'), log, {
      provisioner: fakeProvisioner(),
    });

    expect(result.meeting.id).toBe(MEETING_ID);
    // ⚠ EXACT KEY SET, not a partial match. This is the ONLY Axiom line for a
    // contract-violation projection — it returns before the outcome line can fire — so an
    // Axiom query on `deliveryMode` undercounts unless `party` and `deliveryMode` are here.
    const [failureMeta] = vi.mocked(log.error).mock.calls.at(-1) ?? [];
    expect(Object.keys(failureMeta as Record<string, unknown>).sort()).toEqual([
      'contextId',
      'contextType',
      'deliveryMode',
      'error',
      'meetingId',
      'party',
      'stack',
    ]);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        contextType: 'case',
        party: 'expert',
        deliveryMode: 'failed',
      }),
      'The expert calendar projection threw despite its never-throws contract — booking stands'
    );
    // The emit stays unconditional — one outcome vocabulary across both paths.
    expect(mockTrackServer).toHaveBeenCalledWith(
      'meeting_calendar_projected',
      expect.objectContaining({ delivery: 'failed' })
    );
  });

  it('⚠ does NOT project on the idempotent REPLAY path', async () => {
    // Re-running the projection would call `events.create` a SECOND time and, per apiroc skill
    // §M1, could strand a first vendor event rather than re-stamping Balo's own row. The replay
    // goes through `provisionMeeting`, which never reaches the projection at all.
    const stamped = {
      ...unstampedMeeting(),
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
      scheduledStart: START,
      scheduledEnd: END,
    };
    mockFindByBookingIdempotencyKey.mockResolvedValue(stamped);
    mockFindWithContexts.mockResolvedValue({
      contexts: [{ contextType: 'case', contextId: CONTEXT_ID }],
    });
    mockFindById.mockResolvedValue(stamped);

    const result = await bookAndProvisionMeeting(
      bookInput('case', { bookingIdempotencyKey: 'key-replay-1' }),
      log,
      { provisioner: fakeProvisioner() }
    );

    expect(result.meeting.id).toBe(MEETING_ID);
    expect(mockBookMeeting).not.toHaveBeenCalled();
    expect(mockProjectBookingCalendarEvent).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalledWith(
      'meeting_calendar_projected',
      expect.anything()
    );
  });

  it('skips nothing itself when the booking resolved no expertProfileId — the projection answers that', async () => {
    // ⚠ THE NULL-EXPERT BRANCH MOVED. `provision-meeting.ts` no longer inspects
    // `expertProfileId`; `projectBookingCalendarEvent` owns that decision (and returns
    // `'skipped'`). Asserting the CALL still happens is what stops someone re-adding a
    // second, drifting copy of the check here.
    mockBookMeeting.mockResolvedValue({
      meeting: unstampedMeeting(),
      contexts: [],
      expertProfileId: null,
    });
    mockProjectBookingCalendarEvent.mockResolvedValue('skipped');

    await bookAndProvisionMeeting(bookInput('project_discovery', { engagementType: null }), log, {
      provisioner: fakeProvisioner(),
    });

    expect(mockProjectBookingCalendarEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledWith(
      'meeting_calendar_projected',
      expect.objectContaining({ delivery: 'skipped' })
    );
  });
});
