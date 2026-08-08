import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { ProvisionedRoom, RoomProvisioner } from '../daily/rooms.js';

const { mockFindById, mockSetVenue, mockBookMeeting, mockTrackServer } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockSetVenue: vi.fn(),
  mockBookMeeting: vi.fn(),
  mockTrackServer: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockFindById, setVenue: mockSetVenue },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  MEETING_SERVER_EVENTS: {
    MEETING_PROVISIONED: 'meeting_provisioned',
    MEETING_PROVISION_FAILED: 'meeting_provision_failed',
  },
}));
vi.mock('./meeting-availability.js', () => ({ bookMeeting: mockBookMeeting }));
// `@balo/shared/meetings` is deliberately NOT mocked — the real `dailyRoomNameForMeeting` is
// the arbiter the whole idempotency argument rests on, so the tests must see the real name.

// The REAL error class — `instanceof` is what decides whether the vendor's response body
// reaches the log, so a local stand-in would make that assertion vacuous.
import { DailyApiError } from '../daily/errors.js';
import { bookAndProvisionMeeting, provisionMeeting } from './provision-meeting.js';

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
      },
      log
    );
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
