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
    invoke: () => cancelMeeting(MEETING_ID, log),
    expectedArgs: [MEETING_ID],
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

    await cancelMeeting(MEETING_ID, log);

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
