import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFindById,
  mockFindLiveExpertProviderEvent,
  mockSoftDeleteByMeetingAndParty,
  mockListConnectionsByExpertProfileId,
  mockUpdateConsultationEvent,
  ApirocErrorStub,
  mockAdd,
} = vi.hoisted(() => {
  class ApirocErrorStubImpl extends Error {
    readonly kind: string;
    readonly requestId?: string;
    constructor(kind: string, requestId?: string) {
      super(`apiroc error (${kind})`);
      this.name = 'ApirocError';
      this.kind = kind;
      this.requestId = requestId;
    }
  }
  return {
    mockFindById: vi.fn(),
    mockFindLiveExpertProviderEvent: vi.fn(),
    mockSoftDeleteByMeetingAndParty: vi.fn(),
    mockListConnectionsByExpertProfileId: vi.fn(),
    mockUpdateConsultationEvent: vi.fn(),
    ApirocErrorStub: ApirocErrorStubImpl,
    mockAdd: vi.fn().mockResolvedValue(undefined),
  };
});

// BAL-531 — `getQueue` IS now mocked (it used to be left real; see the historical note below),
// but `buildJobId` is kept REAL via `importOriginal`: a mocked `buildJobId` would prove nothing
// about the new enqueue test's jobId string assertion.
vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  getQueue: vi.fn(() => ({ add: mockAdd })),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockFindById },
  meetingCalendarEventsRepository: {
    findLiveExpertProviderEvent: mockFindLiveExpertProviderEvent,
    softDeleteByMeetingAndParty: mockSoftDeleteByMeetingAndParty,
  },
  calendarRepository: { listConnectionsByExpertProfileId: mockListConnectionsByExpertProfileId },
}));

vi.mock('../services/consultation-events/index.js', () => ({
  updateConsultationEvent: mockUpdateConsultationEvent,
}));

vi.mock('../lib/apiroc/errors.js', () => ({
  ApirocError: ApirocErrorStub,
}));

// `createRedisConnection` is not exercised by `processMeetingCalendarAmend` or
// `enqueueMeetingCalendarAmend` (only by `startMeetingCalendarAmendWorker`, which these tests
// never call), so it is left real — importing it constructs no connection until invoked.
// `getQueue` is NO LONGER left real (BAL-531): the new enqueue test below needs to assert on
// `mockAdd`'s arguments.

const { processMeetingCalendarAmend, enqueueMeetingCalendarAmend } =
  await import('./meeting-calendar-amend.js');

const MEETING_ID = 'meeting-1';
const EXPERT_PROFILE_ID = 'expert-1';

function fakeJob(overrides: Record<string, unknown> = {}) {
  return {
    data: { meetingId: MEETING_ID, expertProfileId: EXPERT_PROFILE_ID },
    log: vi.fn(),
    attemptsMade: 1,
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
    // `updateData` is how the rate-limit deferral counter is persisted between deferrals —
    // `moveToDelayed` does NOT consume an attempt, so `attempts: 5` cannot bound that path
    // and only the counter can.
    updateData: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as never;
}

function meetingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MEETING_ID,
    status: 'scheduled',
    scheduledStart: new Date('2026-09-01T10:00:00.000Z'),
    scheduledEnd: new Date('2026-09-01T10:30:00.000Z'),
    ...overrides,
  };
}

function calendarEventRow(overrides: Record<string, unknown> = {}) {
  return {
    meetingId: MEETING_ID,
    connectionId: 'conn-1',
    calendarId: 'cal-primary',
    vendorEventId: 'vendor-event-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue(meetingRow());
  mockFindLiveExpertProviderEvent.mockResolvedValue(calendarEventRow());
  mockListConnectionsByExpertProfileId.mockResolvedValue([
    { id: 'conn-1', endUserAccountId: 'eua-1' },
  ]);
  mockUpdateConsultationEvent.mockResolvedValue(undefined);
});

describe('processMeetingCalendarAmend — T-JOB (BAL-409 §4)', () => {
  it('missing meeting ⇒ converged, no vendor call', async () => {
    mockFindById.mockResolvedValue(undefined);

    await processMeetingCalendarAmend(fakeJob());

    expect(mockUpdateConsultationEvent).not.toHaveBeenCalled();
  });

  it('cancelled meeting ⇒ converged, no vendor call (the delete is BAL-476’s)', async () => {
    mockFindById.mockResolvedValue(meetingRow({ status: 'cancelled' }));

    await processMeetingCalendarAmend(fakeJob());

    expect(mockUpdateConsultationEvent).not.toHaveBeenCalled();
  });

  it('no live expert-party PROVIDER event ⇒ converged, no vendor call', async () => {
    // BAL-433: `undefined` here now covers THREE cases, not one — no connected calendar, a
    // skipped projection, and an `ics` FALLBACK meeting (ADR-1044 Ruling 1), which names no
    // vendor event at all. Re-sending an updated ICS is BAL-475/BAL-476's, not this job's.
    mockFindLiveExpertProviderEvent.mockResolvedValue(undefined);

    await processMeetingCalendarAmend(fakeJob());

    expect(mockUpdateConsultationEvent).not.toHaveBeenCalled();
    expect(mockSoftDeleteByMeetingAndParty).not.toHaveBeenCalled();
  });

  it('the stored connection no longer exists ⇒ warns, no vendor call', async () => {
    mockListConnectionsByExpertProfileId.mockResolvedValue([]);

    await processMeetingCalendarAmend(fakeJob());

    expect(mockUpdateConsultationEvent).not.toHaveBeenCalled();
  });

  it('⚠⚠ THE CONVERGENCE PROPERTY — amends to the window read from the DB, NOT the job payload', async () => {
    // The payload's window (if it carried one) would differ from what's on the fresh row.
    // The handler must use `meeting.scheduledStart`/`scheduledEnd`, never anything from
    // `job.data` beyond `meetingId`/`expertProfileId`.
    mockFindById.mockResolvedValue(
      meetingRow({
        scheduledStart: new Date('2026-09-05T14:00:00.000Z'),
        scheduledEnd: new Date('2026-09-05T14:30:00.000Z'),
      })
    );

    await processMeetingCalendarAmend(fakeJob());

    expect(mockUpdateConsultationEvent).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      endUserAccountId: 'eua-1',
      calendarId: 'cal-primary',
      vendorEventId: 'vendor-event-1',
      startAt: new Date('2026-09-05T14:00:00.000Z'),
      endAt: new Date('2026-09-05T14:30:00.000Z'),
    });
  });

  it('uses the STORED calendarId, never the current target_calendar_id', async () => {
    mockFindLiveExpertProviderEvent.mockResolvedValue(
      calendarEventRow({ calendarId: 'stored-cal' })
    );

    await processMeetingCalendarAmend(fakeJob());

    expect(mockUpdateConsultationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 'stored-cal' })
    );
  });

  it('a RETRYABLE ApirocError (server_error) rethrows — BullMQ retries', async () => {
    mockUpdateConsultationEvent.mockRejectedValue(new ApirocErrorStub('server_error', 'req-1'));

    await expect(processMeetingCalendarAmend(fakeJob())).rejects.toThrow();
  });

  it('a `not_found` ApirocError soft-deletes the EXPERT-PARTY row only and does NOT rethrow', async () => {
    mockUpdateConsultationEvent.mockRejectedValue(new ApirocErrorStub('not_found'));

    await expect(processMeetingCalendarAmend(fakeJob())).resolves.toBeUndefined();
    // ⚠ THE `'expert'` ARGUMENT IS THE POINT (BAL-433). The 404 happened on the expert's
    // calendar; a whole-meeting soft delete would take a client-party row as collateral.
    expect(mockSoftDeleteByMeetingAndParty).toHaveBeenCalledWith(MEETING_ID, 'expert');
  });

  it('a `forbidden` ApirocError logs and returns — does not burn retries', async () => {
    mockUpdateConsultationEvent.mockRejectedValue(new ApirocErrorStub('forbidden'));

    await expect(processMeetingCalendarAmend(fakeJob())).resolves.toBeUndefined();
    expect(mockSoftDeleteByMeetingAndParty).not.toHaveBeenCalled();
  });

  it('an unrecognized (non-ApirocError) error rethrows', async () => {
    mockUpdateConsultationEvent.mockRejectedValue(new Error('totally unexpected'));

    await expect(processMeetingCalendarAmend(fakeJob())).rejects.toThrow('totally unexpected');
  });

  // N7 — the retry/no-retry split is now `classifyRetry`'s, and a `rate_limited` failure must
  // honour the vendor's own `Retry-After` via a delayed retry, not the queue's generic
  // exponential backoff.
  describe('N7 — classifyRetry drives retry, and rate_limited honours retryAfterSeconds', () => {
    it('rate_limited WITH a token: moves the job to delayed by retryAfterSeconds, throws DelayedError', async () => {
      mockUpdateConsultationEvent.mockRejectedValue(
        Object.assign(new ApirocErrorStub('rate_limited', 'req-1'), { retryAfterSeconds: 30 })
      );
      const moveToDelayed = vi.fn().mockResolvedValue(undefined);
      const job = fakeJob({ moveToDelayed });

      await expect(processMeetingCalendarAmend(job, 'token-1')).rejects.toThrow(
        expect.objectContaining({ name: 'DelayedError' })
      );

      expect(moveToDelayed).toHaveBeenCalledTimes(1);
      const [delayUntil, token] = moveToDelayed.mock.calls[0] as [number, string];
      expect(token).toBe('token-1');
      // 30s, not the DEFAULT_RATE_LIMIT_BACKOFF_MS fallback — the vendor's own value is honoured.
      expect(delayUntil).toBeGreaterThan(Date.now() + 29_000);
      expect(delayUntil).toBeLessThanOrEqual(Date.now() + 30_000);
    });

    /**
     * ⚠ THE UNBOUNDED-RETRY REGRESSION. `job.moveToDelayed()` + `DelayedError` deliberately
     * does NOT consume a BullMQ attempt, so the queue's `attempts: 5` does not bound this path
     * at all: a vendor that keeps answering `rate_limited` would be deferred forever, bounded
     * only by each `Retry-After`, never failing and never becoming visible in the failed set.
     * Past the ceiling the job must fall through to an ORDINARY attempt so it can terminate.
     */
    it('stops deferring past the ceiling and rethrows so an attempt is finally consumed', async () => {
      mockUpdateConsultationEvent.mockRejectedValue(
        Object.assign(new ApirocErrorStub('rate_limited', 'req-1'), { retryAfterSeconds: 30 })
      );
      const moveToDelayed = vi.fn().mockResolvedValue(undefined);
      const job = fakeJob({
        moveToDelayed,
        data: {
          meetingId: MEETING_ID,
          expertProfileId: EXPERT_PROFILE_ID,
          rateLimitDeferrals: 10,
        },
      });

      // Not a DelayedError — the original vendor error, so BullMQ counts the attempt.
      await expect(processMeetingCalendarAmend(job, 'token-1')).rejects.toThrow(
        expect.objectContaining({ kind: 'rate_limited' })
      );
      expect(moveToDelayed).not.toHaveBeenCalled();
    });

    it('counts each deferral so successive rate limits converge on the ceiling', async () => {
      mockUpdateConsultationEvent.mockRejectedValue(
        Object.assign(new ApirocErrorStub('rate_limited', 'req-1'), { retryAfterSeconds: 30 })
      );
      const updateData = vi.fn().mockResolvedValue(undefined);
      const job = fakeJob({
        updateData,
        data: {
          meetingId: MEETING_ID,
          expertProfileId: EXPERT_PROFILE_ID,
          rateLimitDeferrals: 3,
        },
      });

      await expect(processMeetingCalendarAmend(job, 'token-1')).rejects.toThrow(
        expect.objectContaining({ name: 'DelayedError' })
      );
      expect(updateData).toHaveBeenCalledWith(expect.objectContaining({ rateLimitDeferrals: 4 }));
    });

    it('rate_limited with NO token: falls back to a plain rethrow (generic backoff)', async () => {
      mockUpdateConsultationEvent.mockRejectedValue(
        Object.assign(new ApirocErrorStub('rate_limited', 'req-1'), { retryAfterSeconds: 30 })
      );
      const moveToDelayed = vi.fn().mockResolvedValue(undefined);
      const job = fakeJob({ moveToDelayed });

      await expect(processMeetingCalendarAmend(job)).rejects.toThrow();
      expect(moveToDelayed).not.toHaveBeenCalled();
    });

    it('network errors still retry via a plain rethrow (no afterMs — classifyRetry gives none)', async () => {
      mockUpdateConsultationEvent.mockRejectedValue(new ApirocErrorStub('network', 'req-1'));
      const moveToDelayed = vi.fn().mockResolvedValue(undefined);
      const job = fakeJob({ moveToDelayed });

      await expect(processMeetingCalendarAmend(job, 'token-1')).rejects.toThrow();
      expect(moveToDelayed).not.toHaveBeenCalled();
    });

    it('a `validation` ApirocError (classifyRetry: never) logs and returns, never retried', async () => {
      mockUpdateConsultationEvent.mockRejectedValue(new ApirocErrorStub('validation'));

      await expect(processMeetingCalendarAmend(fakeJob())).resolves.toBeUndefined();
      expect(mockSoftDeleteByMeetingAndParty).not.toHaveBeenCalled();
    });
  });
});

describe('enqueueMeetingCalendarAmend — BAL-531', () => {
  it('enqueues with a colon-free jobId built by the REAL buildJobId', async () => {
    await enqueueMeetingCalendarAmend(MEETING_ID, EXPERT_PROFILE_ID, 'audit-1');

    expect(mockAdd).toHaveBeenCalledWith(
      'amend',
      { meetingId: MEETING_ID, expertProfileId: EXPERT_PROFILE_ID },
      expect.objectContaining({
        jobId: 'meeting-calendar-amend--audit-1',
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      })
    );

    const [, , opts] = mockAdd.mock.calls[0] as [unknown, unknown, { jobId: string }];
    expect(opts.jobId).not.toContain(':');
  });
});
