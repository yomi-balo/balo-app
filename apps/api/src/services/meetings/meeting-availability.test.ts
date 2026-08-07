import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockCreate, mockUpdateSchedule, mockCancel, mockSoftDelete, mockEnqueue } = vi.hoisted(
  () => ({
    mockCreate: vi.fn(),
    mockUpdateSchedule: vi.fn(),
    mockCancel: vi.fn(),
    mockSoftDelete: vi.fn(),
    mockEnqueue: vi.fn().mockResolvedValue(undefined),
  })
);

vi.mock('@balo/db', () => ({
  meetingsRepository: {
    create: mockCreate,
    updateSchedule: mockUpdateSchedule,
    cancel: mockCancel,
    softDelete: mockSoftDelete,
  },
}));

vi.mock('../../jobs/availability-cache.js', () => ({
  enqueueAvailabilityCacheRebuild: mockEnqueue,
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
    name: 'rescheduleMeeting',
    repositoryMock: mockUpdateSchedule,
    invoke: () => rescheduleMeeting(MEETING_ID, SCHEDULE, log),
    expectedArgs: [MEETING_ID, SCHEDULE],
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
