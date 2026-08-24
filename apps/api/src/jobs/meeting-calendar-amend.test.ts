import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockFindById,
  mockFindLiveByMeetingId,
  mockSoftDeleteByMeetingId,
  mockListConnectionsByExpertProfileId,
  mockUpdateConsultationEvent,
  ApirocErrorStub,
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
    mockFindLiveByMeetingId: vi.fn(),
    mockSoftDeleteByMeetingId: vi.fn(),
    mockListConnectionsByExpertProfileId: vi.fn(),
    mockUpdateConsultationEvent: vi.fn(),
    ApirocErrorStub: ApirocErrorStubImpl,
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockFindById },
  meetingCalendarEventsRepository: {
    findLiveByMeetingId: mockFindLiveByMeetingId,
    softDeleteByMeetingId: mockSoftDeleteByMeetingId,
  },
  calendarRepository: { listConnectionsByExpertProfileId: mockListConnectionsByExpertProfileId },
}));

vi.mock('../services/consultation-events/index.js', () => ({
  updateConsultationEvent: mockUpdateConsultationEvent,
}));

vi.mock('../lib/apiroc/errors.js', () => ({
  ApirocError: ApirocErrorStub,
}));

// `getQueue`/`createRedisConnection` are not exercised by `processMeetingCalendarAmend`
// directly (only by `enqueueMeetingCalendarAmend`/`startMeetingCalendarAmendWorker`, neither
// of which these tests call), so they are left real — importing them constructs no connection
// until actually invoked.

const { processMeetingCalendarAmend } = await import('./meeting-calendar-amend.js');

const MEETING_ID = 'meeting-1';
const EXPERT_PROFILE_ID = 'expert-1';

function fakeJob(overrides: Record<string, unknown> = {}) {
  return {
    data: { meetingId: MEETING_ID, expertProfileId: EXPERT_PROFILE_ID },
    log: vi.fn(),
    attemptsMade: 1,
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
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
  mockFindLiveByMeetingId.mockResolvedValue(calendarEventRow());
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

  it('cancelled meeting ⇒ converged, no vendor call (the delete is BAL-410’s)', async () => {
    mockFindById.mockResolvedValue(meetingRow({ status: 'cancelled' }));

    await processMeetingCalendarAmend(fakeJob());

    expect(mockUpdateConsultationEvent).not.toHaveBeenCalled();
  });

  it('no live calendar_events row ⇒ no vendor call (the expert has no connected calendar)', async () => {
    mockFindLiveByMeetingId.mockResolvedValue(undefined);

    await processMeetingCalendarAmend(fakeJob());

    expect(mockUpdateConsultationEvent).not.toHaveBeenCalled();
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
    mockFindLiveByMeetingId.mockResolvedValue(calendarEventRow({ calendarId: 'stored-cal' }));

    await processMeetingCalendarAmend(fakeJob());

    expect(mockUpdateConsultationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 'stored-cal' })
    );
  });

  it('a RETRYABLE ApirocError (server_error) rethrows — BullMQ retries', async () => {
    mockUpdateConsultationEvent.mockRejectedValue(new ApirocErrorStub('server_error', 'req-1'));

    await expect(processMeetingCalendarAmend(fakeJob())).rejects.toThrow();
  });

  it('a `not_found` ApirocError soft-deletes the row and does NOT rethrow', async () => {
    mockUpdateConsultationEvent.mockRejectedValue(new ApirocErrorStub('not_found'));

    await expect(processMeetingCalendarAmend(fakeJob())).resolves.toBeUndefined();
    expect(mockSoftDeleteByMeetingId).toHaveBeenCalledWith(MEETING_ID);
  });

  it('a `forbidden` ApirocError logs and returns — does not burn retries', async () => {
    mockUpdateConsultationEvent.mockRejectedValue(new ApirocErrorStub('forbidden'));

    await expect(processMeetingCalendarAmend(fakeJob())).resolves.toBeUndefined();
    expect(mockSoftDeleteByMeetingId).not.toHaveBeenCalled();
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
      expect(mockSoftDeleteByMeetingId).not.toHaveBeenCalled();
    });
  });
});
