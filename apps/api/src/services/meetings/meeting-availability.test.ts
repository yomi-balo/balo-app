import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

// ── Mocks ────────────────────────────────────────────────────────────────────

const {
  mockCreate,
  mockUpdateSchedule,
  mockCancel,
  mockSoftDelete,
  mockEnqueue,
  mockListByMeeting,
  mockListLiveByMeeting,
  mockPublish,
  mockEnqueueCalendarAmend,
  mockResolveMeetingTitle,
  mockFormatExpiryDate,
  mockFindSessionIdByMeetingId,
  mockFindSessionById,
  mockCancelSession,
  mockDeleteRoom,
  MockInvalidSessionTransitionError,
} = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdateSchedule: vi.fn(),
  mockCancel: vi.fn(),
  mockSoftDelete: vi.fn(),
  mockEnqueue: vi.fn().mockResolvedValue(undefined),
  mockListByMeeting: vi.fn().mockResolvedValue([]),
  mockListLiveByMeeting: vi.fn().mockResolvedValue([]),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockEnqueueCalendarAmend: vi.fn().mockResolvedValue(undefined),
  mockResolveMeetingTitle: vi.fn().mockResolvedValue('the video call'),
  mockFormatExpiryDate: vi.fn().mockReturnValue('8 September 2026'),
  // BAL-410 — the credit unwind (step 2) and the vendor teardown (step 3).
  mockFindSessionIdByMeetingId: vi.fn().mockResolvedValue(undefined),
  // ⚠ The PLACER read (security LOW-3): `credit_holds.member_id` records who PLACED the hold,
  // never who cancelled — so the service reads the session and passes `initiatingMemberId`.
  mockFindSessionById: vi.fn().mockResolvedValue(undefined),
  mockCancelSession: vi.fn(),
  mockDeleteRoom: vi.fn().mockResolvedValue('deleted'),
  /**
   * BAL-410 — the real `InvalidSessionTransitionError` cannot be imported here (`@balo/db` is
   * factory-mocked below), so the mock exports a stand-in the service's `instanceof` check
   * recognises. ⚠ IT MUST LIVE INSIDE `vi.hoisted`: `vi.mock`'s factory is hoisted above every
   * top-level declaration, so a class declared beside it is in its temporal dead zone when the
   * factory runs. Named `InvalidSessionTransitionError` so the log assertion reads truthfully.
   */
  MockInvalidSessionTransitionError: class extends Error {
    constructor(from: string) {
      super(`Cannot transition session from ${from} to cancelled`);
      this.name = 'InvalidSessionTransitionError';
    }
  },
}));

vi.mock('@balo/db', () => ({
  meetingsRepository: {
    create: mockCreate,
    updateSchedule: mockUpdateSchedule,
    cancel: mockCancel,
    softDelete: mockSoftDelete,
  },
  meetingContextsRepository: { listByMeeting: mockListByMeeting },
  meetingGuestsRepository: { listLiveByMeeting: mockListLiveByMeeting },
  creditSessionsRepository: {
    findIdByMeetingId: mockFindSessionIdByMeetingId,
    findById: mockFindSessionById,
    cancel: mockCancelSession,
  },
  InvalidSessionTransitionError: MockInvalidSessionTransitionError,
}));

vi.mock('../daily/rooms.js', () => ({
  dailyRoomTeardown: { deleteRoom: mockDeleteRoom },
}));

vi.mock('../../jobs/availability-cache.js', () => ({
  enqueueAvailabilityCacheRebuild: mockEnqueue,
}));

vi.mock('../../jobs/meeting-calendar-amend.js', () => ({
  enqueueMeetingCalendarAmend: mockEnqueueCalendarAmend,
}));

vi.mock('../../notifications/index.js', () => ({
  notificationEvents: { publish: mockPublish },
}));

vi.mock('./guest-participation.js', () => ({
  formatExpiryDate: mockFormatExpiryDate,
  resolveMeetingTitle: mockResolveMeetingTitle,
}));

import { dailyRoomNameForMeeting } from '@balo/shared/meetings';
import {
  bookMeeting,
  cancelMeeting,
  rescheduleMeeting,
  softDeleteMeeting,
} from './meeting-availability.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EXPERT_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';

const log = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
} as unknown as FastifyBaseLogger;

const SCHEDULE = {
  scheduledStart: new Date('2026-09-01T09:00:00.000Z'),
  scheduledEnd: new Date('2026-09-01T10:00:00.000Z'),
};

const CREATE_INPUT = {
  ...SCHEDULE,
  contexts: [{ contextType: 'case' as const, contextId: ENGAGEMENT_ID }],
};

/** BAL-410 — the acting user threaded into the audit row and the hold's `member_id`. */
const CANCEL_ACTOR_ID = '66666666-6666-4666-8666-666666666666';
/** The member who PLACED the hold — deliberately NOT `CANCEL_ACTOR_ID` (security LOW-3). */
const PLACER_MEMBER_ID = '77777777-7777-4777-8777-777777777777';
const CANCEL_AUDIT_ID = '77777777-7777-4777-8777-777777777777';
const HOLD_ID = '88888888-8888-4888-8888-888888888888';

function meetingResult(expertProfileId: string | null): {
  meeting: { id: string };
  contexts: never[];
  expertProfileId: string | null;
} {
  return { meeting: { id: MEETING_ID }, contexts: [], expertProfileId };
}

/**
 * The four mutators, as data. Each entry pairs the service function with the repository
 * method it must delegate to, so every assertion below runs for all four rather than
 * being copy-pasted (and quietly drifting) per mutator.
 */
const MUTATORS = [
  {
    name: 'bookMeeting',
    repositoryMock: mockCreate,
    invoke: () => bookMeeting(CREATE_INPUT, log),
    expectedArgs: [CREATE_INPUT],
  },
  {
    name: 'cancelMeeting',
    repositoryMock: mockCancel,
    invoke: () => cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log),
    // BAL-410 — the audit tuple is threaded through, so the `meeting.cancelled` row records
    // WHICH ARM authorized the cancel rather than an unattributed state change.
    expectedArgs: [MEETING_ID, { actorUserId: CANCEL_ACTOR_ID, actorRole: 'client' }],
  },
  {
    name: 'softDeleteMeeting',
    repositoryMock: mockSoftDelete,
    invoke: () => softDeleteMeeting(MEETING_ID, log),
    expectedArgs: [MEETING_ID],
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnqueue.mockResolvedValue(undefined);
  mockListByMeeting.mockResolvedValue([]);
  mockListLiveByMeeting.mockResolvedValue([]);
  mockPublish.mockResolvedValue(undefined);
  mockEnqueueCalendarAmend.mockResolvedValue(undefined);
  mockResolveMeetingTitle.mockResolvedValue('the video call');
  mockFormatExpiryDate.mockReturnValue('8 September 2026');
  mockFindSessionIdByMeetingId.mockResolvedValue(undefined);
  mockFindSessionById.mockResolvedValue({ id: 'session-1', initiatingMemberId: PLACER_MEMBER_ID });
  mockCancelSession.mockResolvedValue({ id: 'session-1', holdId: HOLD_ID });
  mockDeleteRoom.mockResolvedValue('deleted');
});

// ── The contract ─────────────────────────────────────────────────────────────

describe('meeting-availability — every mutation rebuilds the moved expert’s cache', () => {
  it.each(MUTATORS)(
    '$name delegates to its repository method and enqueues a rebuild for the expert IT returned',
    async ({ repositoryMock, invoke, expectedArgs }) => {
      repositoryMock.mockResolvedValue(meetingResult(EXPERT_ID));

      const result = await invoke();

      expect(repositoryMock).toHaveBeenCalledWith(...expectedArgs);
      // The id comes from the REPOSITORY's return value — never re-resolved by the
      // caller, and never guessed from the input.
      expect(mockEnqueue).toHaveBeenCalledWith(EXPERT_ID, log);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(result.expertProfileId).toBe(EXPERT_ID);
    }
  );

  it.each(MUTATORS)(
    '$name enqueues NOTHING when the mutation moved no expert (an admin meeting)',
    async ({ repositoryMock, invoke }) => {
      // `null` is the repository's honest "there is no projection row" answer. Enqueuing
      // for it would mean rebuilding an availability cache that nothing changed.
      repositoryMock.mockResolvedValue(meetingResult(null));

      await invoke();

      expect(mockEnqueue).not.toHaveBeenCalled();
    }
  );

  it.each(MUTATORS)(
    '$name lets the repository’s typed error propagate and enqueues NOTHING',
    async ({ repositoryMock, invoke }) => {
      // The rebuild is POST-COMMIT: a rolled-back mutation must not advertise a change.
      // And the typed error has to reach BAL-129's route intact — this module never
      // flattens it into a 500.
      class MeetingExpertAmbiguousError extends Error {}
      repositoryMock.mockRejectedValue(new MeetingExpertAmbiguousError('two experts'));

      await expect(invoke()).rejects.toBeInstanceOf(MeetingExpertAmbiguousError);
      expect(mockEnqueue).not.toHaveBeenCalled();
    }
  );

  it('a REAL Redis failure inside the enqueue does NOT fail the mutation', async () => {
    // ⚠ THIS TEST DELIBERATELY BYPASSES THIS FILE'S `jobs/availability-cache.js` MOCK.
    //
    // The claim is that `enqueueAvailabilityCacheRebuild` swallows and logs its own Redis
    // errors, which is the ONLY reason this module can carry no try/catch. Asserting that
    // against the module-level mock would prove nothing: the mock resolves by construction,
    // so the test would pass just as happily if the real enqueue rethrew. So we reset the
    // module registry, un-mock the jobs module, mock ONE layer lower (`getQueue`, the way
    // `booking-availability.integration.test.ts` does) to THROW, and re-import the service
    // so it binds the REAL enqueue. `vi.mock('@balo/db')` is hoisted and survives the reset,
    // so `mockCreate` still drives the repository.
    vi.resetModules();
    vi.doUnmock('../../jobs/availability-cache.js');
    vi.doMock('../../lib/queue.js', () => ({
      getQueue: vi.fn(() => {
        throw new Error('REDIS_URL is not configured');
      }),
    }));

    try {
      const { bookMeeting: bookWithRealEnqueue } = await import('./meeting-availability.js');
      mockCreate.mockResolvedValue(meetingResult(EXPERT_ID));

      // The mutation COMMITTED. A stale availability cache is recoverable (the next
      // trigger, or the staleness cron, rebuilds it); a booking that throws after its
      // transaction committed is not.
      await expect(bookWithRealEnqueue(CREATE_INPUT, log)).resolves.toMatchObject({
        expertProfileId: EXPERT_ID,
      });
      // …and the failure was not swallowed SILENTLY — it reached the log boundary.
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ expertProfileId: EXPERT_ID }),
        'Failed to enqueue availability cache rebuild job'
      );
    } finally {
      // Restore this file's module graph for every test that runs after it.
      vi.doUnmock('../../lib/queue.js');
      vi.doMock('../../jobs/availability-cache.js', () => ({
        enqueueAvailabilityCacheRebuild: mockEnqueue,
      }));
      vi.resetModules();
    }
  });

  it('bookMeeting returns the created meeting AND its context rows', async () => {
    mockCreate.mockResolvedValue({
      meeting: { id: MEETING_ID },
      contexts: [{ id: 'ctx-1' }],
      expertProfileId: EXPERT_ID,
    });

    const created = await bookMeeting(CREATE_INPUT, log);

    expect(created.meeting.id).toBe(MEETING_ID);
    expect(created.contexts).toHaveLength(1);
  });

  it('the enqueue happens AFTER the repository call, never before it', async () => {
    const order: string[] = [];
    mockCancel.mockImplementation(async () => {
      order.push('repository');
      return meetingResult(EXPERT_ID);
    });
    mockEnqueue.mockImplementation(async () => {
      order.push('enqueue');
    });

    await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(order).toEqual(['repository', 'enqueue']);
  });
});

// ── BAL-409 — rescheduleMeeting's own contract (T-API-SVC) ─────────────────────

const ACTOR_USER_ID = '44444444-4444-4444-8444-444444444444';
/** The `meeting.rescheduled` audit row id — the outbound fan-out's per-MOVE dedup key. */
const AUDIT_ID = '55555555-5555-4555-8555-555555555555';

function rescheduleResult(
  expertProfileId: string | null,
  overrides: Record<string, unknown> = {}
): {
  meeting: { id: string; scheduledStart: Date; scheduledEnd: Date };
  expertProfileId: string | null;
  previous: { scheduledStart: Date; scheduledEnd: Date };
  guestLinksExtended: number;
  rescheduleAuditId: string;
} {
  return {
    meeting: { id: MEETING_ID, ...SCHEDULE },
    expertProfileId,
    previous: {
      scheduledStart: new Date('2026-08-25T09:00:00.000Z'),
      scheduledEnd: new Date('2026-08-25T10:00:00.000Z'),
    },
    guestLinksExtended: 0,
    rescheduleAuditId: AUDIT_ID,
    ...overrides,
  };
}

describe('rescheduleMeeting — T-API-SVC', () => {
  it('threads actorUserId into updateSchedule as the third { actorUserId } argument', async () => {
    mockUpdateSchedule.mockResolvedValue(rescheduleResult(EXPERT_ID));

    await rescheduleMeeting(MEETING_ID, SCHEDULE, ACTOR_USER_ID, log);

    expect(mockUpdateSchedule).toHaveBeenCalledWith(MEETING_ID, SCHEDULE, {
      actorUserId: ACTOR_USER_ID,
    });
  });

  it('the availability rebuild still fires exactly once, for the expert the repository returned', async () => {
    mockUpdateSchedule.mockResolvedValue(rescheduleResult(EXPERT_ID));

    await rescheduleMeeting(MEETING_ID, SCHEDULE, ACTOR_USER_ID, log);

    expect(mockEnqueue).toHaveBeenCalledWith(EXPERT_ID, log);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it('enqueues the calendar amend AFTER commit, keyed on the AUDIT ROW ID not the window', async () => {
    const order: string[] = [];
    mockUpdateSchedule.mockImplementation(async () => {
      order.push('repository');
      return rescheduleResult(EXPERT_ID);
    });
    mockEnqueueCalendarAmend.mockImplementation(async () => {
      order.push('enqueue-amend');
    });

    await rescheduleMeeting(MEETING_ID, SCHEDULE, ACTOR_USER_ID, log);

    expect(order).toEqual(['repository', 'enqueue-amend']);
    expect(mockEnqueueCalendarAmend).toHaveBeenCalledWith(MEETING_ID, EXPERT_ID, AUDIT_ID);
  });

  /**
   * ⚠ THE A→B→C→B REGRESSION. Every outbound key used to be derived from the TARGET WINDOW,
   * which is unique per DESTINATION, not per WRITE. A move BACK to a previously-used window
   * regenerated a key already used by the earlier move, and BullMQ silently no-ops an `add`
   * whose jobId still exists in the retained completed set — so the third move's calendar
   * amend and BOTH party emails vanished, leaving Balo on B and the expert's real calendar
   * on C with nothing logged.
   *
   * This asserts the property that makes that impossible: two moves that land on the SAME
   * window still produce DIFFERENT keys, because the key is the append-only audit row id.
   */
  it('gives two moves to the SAME window different keys (A→B→C→B does not dedup)', async () => {
    mockUpdateSchedule.mockResolvedValueOnce(
      rescheduleResult(EXPERT_ID, { rescheduleAuditId: 'audit-first-move-to-B' })
    );
    await rescheduleMeeting(MEETING_ID, SCHEDULE, ACTOR_USER_ID, log);

    // …two moves later, back to the very same window.
    mockUpdateSchedule.mockResolvedValueOnce(
      rescheduleResult(EXPERT_ID, { rescheduleAuditId: 'audit-third-move-back-to-B' })
    );
    await rescheduleMeeting(MEETING_ID, SCHEDULE, ACTOR_USER_ID, log);

    const keys = mockEnqueueCalendarAmend.mock.calls.map((call) => call[2]);
    expect(keys).toEqual(['audit-first-move-to-B', 'audit-third-move-back-to-B']);
    expect(new Set(keys).size).toBe(2);
  });

  it('enqueues NO calendar amend for an admin meeting (no expert)', async () => {
    mockUpdateSchedule.mockResolvedValue(rescheduleResult(null));

    await rescheduleMeeting(MEETING_ID, SCHEDULE, ACTOR_USER_ID, log);

    expect(mockEnqueueCalendarAmend).not.toHaveBeenCalled();
  });

  it('a failed calendar-amend enqueue is logged and does NOT fail the reschedule', async () => {
    mockUpdateSchedule.mockResolvedValue(rescheduleResult(EXPERT_ID));
    mockEnqueueCalendarAmend.mockRejectedValue(new Error('redis down'));

    await expect(
      rescheduleMeeting(MEETING_ID, SCHEDULE, ACTOR_USER_ID, log)
    ).resolves.toMatchObject({ expertProfileId: EXPERT_ID });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID }),
      'Failed to enqueue meeting-calendar-amend job'
    );
  });

  it('publishes meeting.guest_rescheduled once per ADMITTED guest', async () => {
    mockUpdateSchedule.mockResolvedValue(rescheduleResult(EXPERT_ID));
    mockListLiveByMeeting.mockResolvedValue([
      { id: 'guest-1', email: 'a@example.com', name: 'Dana', admission: 'admitted' },
      { id: 'guest-2', email: 'b@example.com', name: null, admission: 'pre_admitted' },
    ]);
    mockListByMeeting.mockResolvedValue([{ contextType: 'case', contextId: 'ctx-1' }]);

    await rescheduleMeeting(MEETING_ID, SCHEDULE, ACTOR_USER_ID, log);

    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockPublish).toHaveBeenCalledWith(
      'meeting.guest_rescheduled',
      expect.objectContaining({ recipientEmail: 'a@example.com', guestName: 'Dana' })
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'meeting.guest_rescheduled',
      expect.not.objectContaining({ guestName: expect.anything() })
    );
  });

  // B1 — an unauthenticated, self-declared lobby knock (`admission: 'pending'`) must never
  // receive the reschedule email: `POST /meetings/:meetingId/lobby` is public and requires no
  // host approval, so a `pending` row can be written by anyone who guesses the meeting uuid.
  it('publishes NOTHING to a pending (un-admitted) guest — B1', async () => {
    mockUpdateSchedule.mockResolvedValue(rescheduleResult(EXPERT_ID));
    mockListLiveByMeeting.mockResolvedValue([
      { id: 'guest-pending', email: 'stranger@example.com', name: null, admission: 'pending' },
    ]);
    mockListByMeeting.mockResolvedValue([{ contextType: 'case', contextId: 'ctx-1' }]);

    await rescheduleMeeting(MEETING_ID, SCHEDULE, ACTOR_USER_ID, log);

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('a throwing guest publish does not fail the reschedule, and does not block the other guests', async () => {
    mockUpdateSchedule.mockResolvedValue(rescheduleResult(EXPERT_ID));
    mockListLiveByMeeting.mockResolvedValue([
      { id: 'guest-1', email: 'a@example.com', name: null, admission: 'admitted' },
      { id: 'guest-2', email: 'b@example.com', name: null, admission: 'admitted' },
    ]);
    mockPublish.mockRejectedValueOnce(new Error('publish failed')).mockResolvedValueOnce(undefined);

    await expect(
      rescheduleMeeting(MEETING_ID, SCHEDULE, ACTOR_USER_ID, log)
    ).resolves.toMatchObject({ expertProfileId: EXPERT_ID });
    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, guestId: 'guest-1' }),
      expect.stringContaining('Failed to publish meeting.guest_rescheduled')
    );
  });

  it('publishes NOTHING when there are no live guests', async () => {
    mockUpdateSchedule.mockResolvedValue(rescheduleResult(EXPERT_ID));
    mockListLiveByMeeting.mockResolvedValue([]);

    await rescheduleMeeting(MEETING_ID, SCHEDULE, ACTOR_USER_ID, log);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockListByMeeting).not.toHaveBeenCalled();
  });
});

// ── BAL-410 — cancelMeeting's own contract (the post-commit unwind) ────────────

/** The room name is a pure function of `meetings.id` — the same derivation the service uses. */
const CORRECT_ROOM_NAME = dailyRoomNameForMeeting(MEETING_ID);

function cancelResult(
  overrides: {
    expertProfileId?: string | null;
    dailyRoomName?: string | null;
  } = {}
): {
  meeting: { id: string; dailyRoomName: string | null; scheduledStart: Date; scheduledEnd: Date };
  expertProfileId: string | null;
  cancelAuditId: string;
} {
  return {
    meeting: {
      id: MEETING_ID,
      dailyRoomName:
        overrides.dailyRoomName === undefined ? CORRECT_ROOM_NAME : overrides.dailyRoomName,
      ...SCHEDULE,
    },
    expertProfileId:
      overrides.expertProfileId === undefined ? EXPERT_ID : overrides.expertProfileId,
    cancelAuditId: CANCEL_AUDIT_ID,
  };
}

describe('cancelMeeting — the post-commit unwind', () => {
  beforeEach(() => {
    mockCancel.mockResolvedValue(cancelResult());
  });

  it('returns the audit row id — the outbound fan-out’s per-WRITE dedup key', async () => {
    const result = await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(result.cancelAuditId).toBe(CANCEL_AUDIT_ID);
  });

  it('threads the acting user AND the matched arm into the audit tuple', async () => {
    await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'expert', log);

    expect(mockCancel).toHaveBeenCalledWith(MEETING_ID, {
      actorUserId: CANCEL_ACTOR_ID,
      actorRole: 'expert',
    });
  });

  it('accepts the system-actor exemption (a null actor with actorRole "system")', async () => {
    await cancelMeeting(MEETING_ID, null, 'system', log);

    expect(mockCancel).toHaveBeenCalledWith(MEETING_ID, {
      actorUserId: null,
      actorRole: 'system',
    });
  });

  // ── Step 2 — the credit unwind. THE HIGHEST-VALUE PART OF THE WHOLE PATH. ──

  it('holdReleased is FALSE and NOTHING is cancelled when no session is bound to the meeting', async () => {
    // The overwhelmingly common case: nobody joined early, so no session was ever opened.
    // It must stay a first-class answer, never a zero-valued stub.
    mockFindSessionIdByMeetingId.mockResolvedValue(undefined);

    const result = await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(result.holdReleased).toBe(false);
    expect(mockCancelSession).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE PLACER, NOT THE CANCELLING ACTOR (security LOW-3). `credit_holds.member_id` is a
   * COMPANY-SCOPED money row; on the expert and admin arms the cancelling actor holds NO
   * membership in the wallet's company, so stamping them there would write a foreign user id
   * into that company's credit history AND destroy the placer's attribution. Every sibling
   * caller in `credit-sessions.ts` passes `session.initiatingMemberId`. The two ids differ in
   * this fixture on purpose — passing the wrong one cannot pass this test.
   */
  it('cancels a bound PENDING session, stamping the PLACER and never the cancelling actor', async () => {
    mockFindSessionIdByMeetingId.mockResolvedValue({ id: 'session-1' });
    mockCancelSession.mockResolvedValue({ id: 'session-1', holdId: HOLD_ID });

    const result = await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(mockCancelSession).toHaveBeenCalledWith('session-1', { memberId: PLACER_MEMBER_ID });
    expect(result.holdReleased).toBe(true);
  });

  /** The EXPERT arm is the case that motivates it: not a member of the wallet's company. */
  it('stamps the PLACER on an EXPERT-initiated cancel too', async () => {
    mockFindSessionIdByMeetingId.mockResolvedValue({ id: 'session-1' });
    mockCancelSession.mockResolvedValue({ id: 'session-1', holdId: HOLD_ID });

    await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'expert', log);

    expect(mockCancelSession).toHaveBeenCalledWith('session-1', { memberId: PLACER_MEMBER_ID });
  });

  /** A vanished session row must not fabricate an attribution — `null`, never the actor. */
  it('passes memberId: null when the session row cannot be re-read', async () => {
    mockFindSessionIdByMeetingId.mockResolvedValue({ id: 'session-1' });
    mockFindSessionById.mockResolvedValue(undefined);
    mockCancelSession.mockResolvedValue({ id: 'session-1', holdId: HOLD_ID });

    await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(mockCancelSession).toHaveBeenCalledWith('session-1', { memberId: null });
  });

  it('reports holdReleased=FALSE when the cancelled session carried no hold', async () => {
    // A session with `holdId: null` released nothing, and the in-app copy must not claim it did.
    mockFindSessionIdByMeetingId.mockResolvedValue({ id: 'session-1' });
    mockCancelSession.mockResolvedValue({ id: 'session-1', holdId: null });

    const result = await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(result.holdReleased).toBe(false);
  });

  it('logs an INVARIANT VIOLATION and does NOT force a metering session', async () => {
    // A metering session means the call is underway — the no-show/settlement path (BAL-412),
    // not cancellation. We refuse loudly rather than recovering.
    mockFindSessionIdByMeetingId.mockResolvedValue({ id: 'session-1' });
    mockCancelSession.mockRejectedValue(new MockInvalidSessionTransitionError('active'));

    const result = await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(result.holdReleased).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        errorName: 'InvalidSessionTransitionError',
      }),
      expect.stringContaining('INVARIANT VIOLATION')
    );
  });

  it('a FAILING credit release does not propagate, and does not stop the room teardown', async () => {
    // The cancel already COMMITTED. A post-commit hiccup must never become a 500, and the
    // vendor teardown must still run.
    mockFindSessionIdByMeetingId.mockRejectedValue(new Error('connection terminated'));

    const result = await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(result.holdReleased).toBe(false);
    expect(mockDeleteRoom).toHaveBeenCalledWith(CORRECT_ROOM_NAME);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID }),
      expect.stringContaining('the backstop sweep will retry')
    );
  });

  // ── Step ORDER — money first, vendor second. The ticket's stated failure mode. ──

  it('⚠ awaits the CREDIT RELEASE strictly BEFORE the room teardown', async () => {
    // Inverted, a crash between the two strands the hold FOREVER and locks the company out of
    // every future Case session. In this order the residual is a live room nobody can rejoin.
    const order: string[] = [];
    mockFindSessionIdByMeetingId.mockImplementation(async () => {
      order.push('credit');
      return { id: 'session-1' };
    });
    mockDeleteRoom.mockImplementation(async () => {
      order.push('room');
      return 'deleted';
    });

    await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(order).toEqual(['credit', 'room']);
  });

  // ── Step 3 — the vendor teardown. ──

  it('deletes the Daily room when the stamped name matches the derived one', async () => {
    await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(mockDeleteRoom).toHaveBeenCalledWith(CORRECT_ROOM_NAME);
  });

  it('deletes NOTHING for an unprovisioned meeting (dailyRoomName === null)', async () => {
    mockCancel.mockResolvedValue(cancelResult({ dailyRoomName: null }));

    await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(mockDeleteRoom).not.toHaveBeenCalled();
  });

  it('⚠ REFUSES to delete a room whose stamped name disagrees with the derived one', async () => {
    // The call is DESTRUCTIVE and irreversible; a divergent name means this row may point at
    // SOMEBODY ELSE'S live room.
    mockCancel.mockResolvedValue(cancelResult({ dailyRoomName: 'somebody-elses-room' }));

    await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(mockDeleteRoom).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ stamped: 'somebody-elses-room', expected: CORRECT_ROOM_NAME }),
      expect.stringContaining('REFUSING to delete a room')
    );
  });

  it('a THROWING room delete does not propagate — the cancellation already committed', async () => {
    mockDeleteRoom.mockRejectedValue(new Error('429 rate limited'));

    await expect(cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log)).resolves.toMatchObject({
      cancelAuditId: CANCEL_AUDIT_ID,
    });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, roomName: CORRECT_ROOM_NAME }),
      expect.stringContaining('Daily room teardown failed')
    );
  });

  it('publishes NOTHING — the seeder is a live caller, so the publish lives in the route', async () => {
    await cancelMeeting(MEETING_ID, CANCEL_ACTOR_ID, 'client', log);

    expect(mockPublish).not.toHaveBeenCalled();
  });
});
