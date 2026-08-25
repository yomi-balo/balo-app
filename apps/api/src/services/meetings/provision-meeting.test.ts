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
  mockFindByEngagementId,
  mockFindCompanyById,
  mockProjectBookingToExpertCalendar,
  mockFindEngagementById,
  mockFindProjectRequestById,
  mockFindRelationshipById,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockSetVenue: vi.fn(),
  mockBookMeeting: vi.fn(),
  mockTrackServer: vi.fn(),
  mockFindByBookingIdempotencyKey: vi.fn(),
  mockFindWithContexts: vi.fn(),
  mockFindByEngagementId: vi.fn(),
  mockFindCompanyById: vi.fn(),
  mockProjectBookingToExpertCalendar: vi.fn(),
  mockFindEngagementById: vi.fn(),
  mockFindProjectRequestById: vi.fn(),
  mockFindRelationshipById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingsRepository: {
    findById: mockFindById,
    setVenue: mockSetVenue,
    findByBookingIdempotencyKey: mockFindByBookingIdempotencyKey,
    findWithContexts: mockFindWithContexts,
  },
  caseEngagementsRepository: { findByEngagementId: mockFindByEngagementId },
  companiesRepository: { findById: mockFindCompanyById },
  // BAL-283 — the `request_interaction` resolver's two-hop reads. `engagementsRepository` is
  // injected but never reached on that arm (its label is relationship-grain); it is mocked
  // because a vitest factory mock throws on any export the module imports and it omits.
  engagementsRepository: { findById: mockFindEngagementById },
  projectRequestsRepository: { findById: mockFindProjectRequestById },
  requestExpertRelationshipsRepository: { findById: mockFindRelationshipById },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  MEETING_SERVER_EVENTS: {
    MEETING_PROVISIONED: 'meeting_provisioned',
    MEETING_PROVISION_FAILED: 'meeting_provision_failed',
  },
}));
vi.mock('./meeting-availability.js', () => ({ bookMeeting: mockBookMeeting }));
vi.mock('../consultation-events/project-booking-to-calendar.js', () => ({
  projectBookingToExpertCalendar: mockProjectBookingToExpertCalendar,
}));
// `@balo/shared/meetings` is deliberately NOT mocked — the real `dailyRoomNameForMeeting` is
// the arbiter the whole idempotency argument rests on, so the tests must see the real name.

// The REAL error class — `instanceof` is what decides whether the vendor's response body
// reaches the log, so a local stand-in would make that assertion vacuous.
import { DailyApiError } from '../daily/errors.js';
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

describe('bookAndProvisionMeeting — the expert calendar projection (BAL-400 D2)', () => {
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
   * BAL-283 — the three contexts BAL-433 still owns. Pinned as a TABLE rather than one
   * `project_kickoff` case, because the whole risk of widening the gate is widening it too far:
   * if a future edit projects one of these with case-shaped facts, this fails immediately.
   */
  it.each(['project_kickoff', 'package_session', 'project_discovery'] as const)(
    'writes NOTHING to a calendar for contextType "%s" (BAL-433 owns these)',
    async (contextType) => {
      mockFindByEngagementId.mockResolvedValue({ companyId: 'company-1', title: 'CPQ rollout' });
      mockFindCompanyById.mockResolvedValue({ id: 'company-1', name: 'Northwind Industrial' });

      await bookAndProvisionMeeting(bookInput(contextType, { engagementType: 'project' }), log, {
        provisioner: fakeProvisioner(),
      });

      expect(mockProjectBookingToExpertCalendar).not.toHaveBeenCalled();
    }
  );

  it('resolves the case + company and calls projectBookingToExpertCalendar for contextType "case"', async () => {
    mockFindByEngagementId.mockResolvedValue({ companyId: 'company-1', title: 'CPQ rollout' });
    mockFindCompanyById.mockResolvedValue({ id: 'company-1', name: 'Northwind Industrial' });

    await bookAndProvisionMeeting(bookInput('case'), log, { provisioner: fakeProvisioner() });

    expect(mockProjectBookingToExpertCalendar).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        expertProfileId: 'expert_1',
        clientCompanyName: 'Northwind Industrial',
        caseTitle: 'CPQ rollout',
        // BAL-283 REGRESSION — the case arm's headline noun must stay BAL-400's, byte for
        // byte, now that it is one of two entries rather than the module's only literal.
        eventLabel: 'Consultation',
      }),
      log
    );
    const [[calendarInput]] = mockProjectBookingToExpertCalendar.mock.calls;
    expect((calendarInput as { joinUrl: string }).joinUrl).toContain(`/join/m/${MEETING_ID}`);
  });

  it('⚠ REGRESSION — the case arm reads the case then the company, and nothing else', async () => {
    // BAL-283 must not have re-routed the `case` two-hop through `resolveContextOwner`: a case
    // context is engagement-grain and resolves its company from `case_engagements`, not from a
    // request. If this starts calling the request/relationship finders, the arms have merged.
    mockFindByEngagementId.mockResolvedValue({ companyId: 'company-1', title: 'CPQ rollout' });
    mockFindCompanyById.mockResolvedValue({ id: 'company-1', name: 'Northwind Industrial' });

    await bookAndProvisionMeeting(bookInput('case'), log, { provisioner: fakeProvisioner() });

    expect(mockFindByEngagementId).toHaveBeenCalledWith(CONTEXT_ID);
    expect(mockFindCompanyById).toHaveBeenCalledWith('company-1');
    expect(mockFindProjectRequestById).not.toHaveBeenCalled();
    expect(mockFindRelationshipById).not.toHaveBeenCalled();
  });

  it('a throwing projection call does NOT fail the booking', async () => {
    mockFindByEngagementId.mockResolvedValue({ companyId: 'company-1', title: 'CPQ rollout' });
    mockFindCompanyById.mockResolvedValue({ id: 'company-1', name: 'Northwind Industrial' });
    mockProjectBookingToExpertCalendar.mockRejectedValue(new Error('should never happen'));

    // `projectBookingToExpertCalendar`'s own contract is "never throws" (D2c) — but the CALL
    // SITE wraps it in a try/catch too, defence-in-depth, so a violation of that contract
    // still cannot turn a committed booking into a rejected promise.
    const result = await bookAndProvisionMeeting(bookInput('case'), log, {
      provisioner: fakeProvisioner(),
    });
    expect(result.meeting.id).toBe(MEETING_ID);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, engagementId: CONTEXT_ID }),
      'Failed to resolve case/company for the expert calendar projection'
    );
  });

  it('skips silently (no throw) when the case has no live company row', async () => {
    mockFindByEngagementId.mockResolvedValue({ companyId: 'company-1', title: 'CPQ rollout' });
    mockFindCompanyById.mockResolvedValue(undefined);

    await expect(
      bookAndProvisionMeeting(bookInput('case'), log, { provisioner: fakeProvisioner() })
    ).resolves.toBeDefined();
    expect(mockProjectBookingToExpertCalendar).not.toHaveBeenCalled();
  });
});

/**
 * BAL-283 — RESOLUTION ENTRY TWO. Before this, an intro call blocked the expert's slot INSIDE
 * Balo (the `consultations` projection) and wrote NOTHING to their Google/Outlook — and because
 * Balo reads their external free/busy, a colleague could book over it undetected.
 *
 * ⚠ `@balo/shared/meetings` IS NOT MOCKED IN THIS FILE, so these exercise the REAL
 * `resolveContextOwner` two-hop — including its axis rule (the EXPERT comes from the
 * relationship, the COMPANY from the request). A stubbed resolver would let the two be swapped
 * and still pass.
 */
describe('bookAndProvisionMeeting — the expert calendar projection for an intro call (BAL-283)', () => {
  const RELATIONSHIP_ID = '66666666-6666-4666-8666-666666666666';
  const REQUEST_ID = '77777777-7777-4777-8777-777777777777';

  function introCallInput(overrides: Partial<BookAndProvisionInput> = {}): BookAndProvisionInput {
    return {
      contextType: 'request_interaction',
      contextId: RELATIONSHIP_ID,
      scheduledStart: START,
      scheduledEnd: END,
      // A `request_interaction` anchors on no engagement, so it carries no engagement type.
      engagementType: null,
      userId: USER_ID,
      ...overrides,
    };
  }

  /** The happy two-hop: relationship → request → company. */
  function wireLiveGraph(requestTitle: string | null = 'Salesforce CPQ rollout'): void {
    mockFindRelationshipById.mockResolvedValue({
      id: RELATIONSHIP_ID,
      projectRequestId: REQUEST_ID,
      expertProfileId: 'expert_1',
    });
    mockFindProjectRequestById.mockResolvedValue({
      id: REQUEST_ID,
      companyId: 'company-9',
      expertProfileId: 'expert_1',
      title: requestTitle,
    });
    mockFindCompanyById.mockResolvedValue({ id: 'company-9', name: 'Northwind Industrial' });
  }

  it('projects the intro call with the client COMPANY and an "Intro call" title', async () => {
    wireLiveGraph();

    await bookAndProvisionMeeting(introCallInput(), log, { provisioner: fakeProvisioner() });

    expect(mockProjectBookingToExpertCalendar).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        expertProfileId: 'expert_1',
        // ADR-1044 §4 — the expert's event names the client COMPANY, never a person.
        clientCompanyName: 'Northwind Industrial',
        // The headline noun, which is what makes the event read as an intro call rather than
        // as a "Consultation" the expert has not agreed to deliver.
        eventLabel: 'Intro call',
        // The subject line is the project request's own title (load-recap resolves this exact
        // context the same way).
        caseTitle: 'Salesforce CPQ rollout',
      }),
      log
    );
    const [[calendarInput]] = mockProjectBookingToExpertCalendar.mock.calls;
    expect((calendarInput as { joinUrl: string }).joinUrl).toContain(`/join/m/${MEETING_ID}`);
  });

  it('reads the company from the REQUEST, one hop past the relationship', async () => {
    wireLiveGraph();

    await bookAndProvisionMeeting(introCallInput(), log, { provisioner: fakeProvisioner() });

    expect(mockFindRelationshipById).toHaveBeenCalledWith(RELATIONSHIP_ID);
    expect(mockFindProjectRequestById).toHaveBeenCalledWith(REQUEST_ID);
    expect(mockFindCompanyById).toHaveBeenCalledWith('company-9');
    // The relationship names no company, so the case reader must never be consulted here.
    expect(mockFindByEngagementId).not.toHaveBeenCalled();
  });

  it('falls back to the "Intro call" label when the request title is blank', async () => {
    wireLiveGraph('   ');

    await bookAndProvisionMeeting(introCallInput(), log, { provisioner: fakeProvisioner() });

    expect(mockProjectBookingToExpertCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ caseTitle: 'Intro call' }),
      log
    );
  });

  it('⚠ carries NO attendees — comms stay in Balo (ADR-1044 §4 / BAL-433 Ruling 2)', async () => {
    wireLiveGraph();

    await bookAndProvisionMeeting(introCallInput(), log, { provisioner: fakeProvisioner() });

    const [[calendarInput]] = mockProjectBookingToExpertCalendar.mock.calls;
    expect(calendarInput).not.toHaveProperty('attendees');
    expect(calendarInput).not.toHaveProperty('generateMeetingUrlProvider');
  });

  it.each([
    ['relationship', () => mockFindRelationshipById.mockResolvedValue(undefined)],
    ['request', () => mockFindProjectRequestById.mockResolvedValue(undefined)],
    ['company', () => mockFindCompanyById.mockResolvedValue(undefined)],
  ])('skips silently (no throw) when the %s row is missing', async (_label, breakRow) => {
    wireLiveGraph();
    breakRow();

    await expect(
      bookAndProvisionMeeting(introCallInput(), log, { provisioner: fakeProvisioner() })
    ).resolves.toBeDefined();
    expect(mockProjectBookingToExpertCalendar).not.toHaveBeenCalled();
  });

  it('never throws, and never undoes the booking, when a read rejects', async () => {
    // The booking has ALREADY COMMITTED by the time the projection runs (D2c) — a repository
    // wobble here must degrade to a logged no-op, never to a rejected promise.
    wireLiveGraph();
    mockFindRelationshipById.mockRejectedValue(new Error('db unavailable'));

    const result = await bookAndProvisionMeeting(introCallInput(), log, {
      provisioner: fakeProvisioner(),
    });

    expect(result.meeting.id).toBe(MEETING_ID);
    expect(mockProjectBookingToExpertCalendar).not.toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, relationshipId: RELATIONSHIP_ID }),
      'Failed to resolve request/company for the expert calendar projection'
    );
  });

  it('skips the projection when the booking resolved no expertProfileId', async () => {
    wireLiveGraph();
    mockBookMeeting.mockResolvedValue({
      meeting: unstampedMeeting(),
      contexts: [],
      expertProfileId: null,
    });

    await expect(
      bookAndProvisionMeeting(introCallInput(), log, { provisioner: fakeProvisioner() })
    ).resolves.toBeDefined();
    expect(mockProjectBookingToExpertCalendar).not.toHaveBeenCalled();
  });

  it('⚠ does NOT project on the idempotent REPLAY path', async () => {
    // Re-running the projection would call `events.create` a SECOND time and, per apiroc skill
    // §M1, could strand a first vendor event rather than re-stamping Balo's own row. The replay
    // goes through `provisionMeeting`, which never reaches the projection at all.
    wireLiveGraph();
    const stamped = {
      ...unstampedMeeting(),
      dailyRoomName: ROOM_NAME,
      joinUrl: JOIN_URL,
      scheduledStart: START,
      scheduledEnd: END,
    };
    mockFindByBookingIdempotencyKey.mockResolvedValue(stamped);
    mockFindWithContexts.mockResolvedValue({
      contexts: [{ contextType: 'request_interaction', contextId: RELATIONSHIP_ID }],
    });
    mockFindById.mockResolvedValue(stamped);

    const result = await bookAndProvisionMeeting(
      introCallInput({ bookingIdempotencyKey: 'key-intro-1' }),
      log,
      { provisioner: fakeProvisioner() }
    );

    expect(result.meeting.id).toBe(MEETING_ID);
    expect(mockBookMeeting).not.toHaveBeenCalled();
    expect(mockProjectBookingToExpertCalendar).not.toHaveBeenCalled();
  });
});
