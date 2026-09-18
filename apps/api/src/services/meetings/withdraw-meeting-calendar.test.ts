import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const {
  mockListLiveByMeeting,
  mockSoftDeleteByMeetingAndParty,
  mockListConnections,
  mockPublishCancellation,
  mockDeleteConsultationEvent,
  mockCaptureException,
} = vi.hoisted(() => ({
  mockListLiveByMeeting: vi.fn(),
  mockSoftDeleteByMeetingAndParty: vi.fn(),
  mockListConnections: vi.fn(),
  mockPublishCancellation: vi.fn(),
  mockDeleteConsultationEvent: vi.fn(),
  mockCaptureException: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingCalendarEventsRepository: {
    listLiveByMeeting: mockListLiveByMeeting,
    softDeleteByMeetingAndParty: mockSoftDeleteByMeetingAndParty,
  },
  calendarRepository: { listConnectionsByExpertProfileId: mockListConnections },
}));
vi.mock('../calendar-invites/publish-calendar-invites.js', () => ({
  publishCancellationCalendarWithdrawals: mockPublishCancellation,
}));
vi.mock('../consultation-events/index.js', () => ({
  deleteConsultationEvent: mockDeleteConsultationEvent,
}));
vi.mock('@sentry/node', () => ({ captureException: mockCaptureException }));

const { ApirocError } = await import('../../lib/apiroc/errors.js');
const { withdrawMeetingCalendarProjection } = await import('./withdraw-meeting-calendar.js');

const MEETING_ID = 'meeting-1';
const CANCEL_AUDIT_ID = 'audit-cancel-1';

const CLIENT_ICS_ROW = {
  id: 'row-client',
  meetingId: MEETING_ID,
  party: 'client',
  deliveryMode: 'ics',
  sequence: 0,
  connectionId: null,
};
const EXPERT_PROVIDER_ROW = {
  id: 'row-expert',
  meetingId: MEETING_ID,
  party: 'expert',
  deliveryMode: 'provider_event',
  sequence: 0,
  connectionId: 'conn-1',
};

/**
 * ⚠ A THREE-METHOD STUB, TYPED BACK TO `FastifyBaseLogger` AT THE CALL BOUNDARY. The orchestrator
 * only ever calls `info` / `warn` / `error`, so a narrower object is honest about the surface —
 * and the returned shape keeps its `vi.fn()` types for the assertions below.
 */
function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** The same stub, widened for the parameter position. */
function asLogger(log: ReturnType<typeof fakeLog>): FastifyBaseLogger {
  return log as unknown as FastifyBaseLogger;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPublishCancellation.mockResolvedValue(undefined);
  mockSoftDeleteByMeetingAndParty.mockResolvedValue(undefined);
  mockDeleteConsultationEvent.mockResolvedValue(undefined);
  mockListConnections.mockResolvedValue([{ id: 'conn-1', endUserAccountId: 'eua-1' }]);
});

describe('withdrawMeetingCalendarProjection — ordering', () => {
  /**
   * ⚠⚠ PUBLISH → VENDOR DELETE → RETIRE, AND THE ORDER IS THE WHOLE ARGUMENT. Retiring first and
   * crashing before the publish leaves every recipient with a stale calendar entry forever, with
   * nothing to re-drive it from — the exact defect this ticket exists to close.
   */
  it('⚠ publishes BEFORE the vendor delete, and retires LAST', async () => {
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ICS_ROW, EXPERT_PROVIDER_ROW]);

    await withdrawMeetingCalendarProjection(
      { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: 'ep-1' },
      asLogger(fakeLog())
    );

    const publishOrder = mockPublishCancellation.mock.invocationCallOrder[0] ?? 0;
    const deleteOrder = mockDeleteConsultationEvent.mock.invocationCallOrder[0] ?? 0;
    const retireOrder = mockSoftDeleteByMeetingAndParty.mock.invocationCallOrder[0] ?? 0;
    expect(publishOrder).toBeGreaterThan(0);
    expect(deleteOrder).toBeGreaterThan(publishOrder);
    expect(retireOrder).toBeGreaterThan(deleteOrder);
  });

  it('hands the publisher the SAME snapshot it retires from', async () => {
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ICS_ROW, EXPERT_PROVIDER_ROW]);

    await withdrawMeetingCalendarProjection(
      { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: 'ep-1' },
      asLogger(fakeLog())
    );

    expect(mockPublishCancellation).toHaveBeenCalledTimes(1);
    expect(mockPublishCancellation).toHaveBeenCalledWith(
      {
        meetingId: MEETING_ID,
        cancelAuditId: CANCEL_AUDIT_ID,
        expertProfileId: 'ep-1',
        calendarEvents: [CLIENT_ICS_ROW, EXPERT_PROVIDER_ROW],
      },
      expect.anything()
    );
    // ONE read, so the publish and the retire cannot disagree.
    expect(mockListLiveByMeeting).toHaveBeenCalledTimes(1);
  });
});

describe('withdrawMeetingCalendarProjection — the terminal retire (T-3)', () => {
  /**
   * ⚠⚠ PARTY-SCOPED, ONE CALL PER ROW WITH THAT ROW'S OWN PARTY. A whole-meeting soft delete
   * would take the CLIENT's row as collateral for something that happened on the expert's
   * calendar — `softDeleteByMeetingAndParty`'s own docblock forbids it.
   */
  it('⚠ retires every row, party-scoped, and NEVER with a whole-meeting shape', async () => {
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ICS_ROW, EXPERT_PROVIDER_ROW]);

    await withdrawMeetingCalendarProjection(
      { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: 'ep-1' },
      asLogger(fakeLog())
    );

    expect(mockSoftDeleteByMeetingAndParty).toHaveBeenCalledTimes(2);
    expect(mockSoftDeleteByMeetingAndParty.mock.calls).toEqual([
      [MEETING_ID, 'client'],
      [MEETING_ID, 'expert'],
    ]);
    for (const call of mockSoftDeleteByMeetingAndParty.mock.calls) {
      expect(call).toHaveLength(2);
      expect(['client', 'expert']).toContain(call[1]);
    }
  });

  /** Constraint 11 — nothing retired the CLIENT party's `ics` row on a cancel before this. */
  it('⚠ retires a CLIENT-ONLY projection, which nothing did before', async () => {
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ICS_ROW]);

    await withdrawMeetingCalendarProjection(
      { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: null },
      asLogger(fakeLog())
    );

    expect(mockSoftDeleteByMeetingAndParty.mock.calls).toEqual([[MEETING_ID, 'client']]);
    expect(mockDeleteConsultationEvent).not.toHaveBeenCalled();
  });

  it('a throwing retire is logged and the remaining rows still retire', async () => {
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ICS_ROW, EXPERT_PROVIDER_ROW]);
    mockSoftDeleteByMeetingAndParty.mockRejectedValueOnce(new Error('db down'));
    const log = fakeLog();

    await expect(
      withdrawMeetingCalendarProjection(
        { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: 'ep-1' },
        asLogger(log)
      )
    ).resolves.toBeUndefined();

    expect(mockSoftDeleteByMeetingAndParty).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, party: 'client' }),
      'Failed to retire the calendar row after a withdrawal'
    );
  });
});

describe('withdrawMeetingCalendarProjection — the vendor arm', () => {
  it('resolves the End User Account off the STORED connectionId and deletes once', async () => {
    mockListLiveByMeeting.mockResolvedValue([EXPERT_PROVIDER_ROW]);
    mockListConnections.mockResolvedValue([
      { id: 'conn-other', endUserAccountId: 'eua-other' },
      { id: 'conn-1', endUserAccountId: 'eua-1' },
    ]);

    await withdrawMeetingCalendarProjection(
      { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: 'ep-1' },
      asLogger(fakeLog())
    );

    expect(mockDeleteConsultationEvent).toHaveBeenCalledTimes(1);
    expect(mockDeleteConsultationEvent).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      endUserAccountId: 'eua-1',
    });
  });

  it('⚠ never touches the vendor for an ICS-ONLY expert row', async () => {
    mockListLiveByMeeting.mockResolvedValue([
      { ...EXPERT_PROVIDER_ROW, deliveryMode: 'ics', connectionId: null },
    ]);

    await withdrawMeetingCalendarProjection(
      { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: 'ep-1' },
      asLogger(fakeLog())
    );

    expect(mockDeleteConsultationEvent).not.toHaveBeenCalled();
    expect(mockSoftDeleteByMeetingAndParty).toHaveBeenCalledTimes(1);
  });

  it('warns and still retires when the cancellation named no expertProfileId', async () => {
    mockListLiveByMeeting.mockResolvedValue([EXPERT_PROVIDER_ROW]);
    const log = fakeLog();

    await withdrawMeetingCalendarProjection(
      { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: null },
      asLogger(log)
    );

    expect(mockDeleteConsultationEvent).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(mockSoftDeleteByMeetingAndParty).toHaveBeenCalledWith(MEETING_ID, 'expert');
  });

  it('warns and still retires when the stored connection no longer exists', async () => {
    mockListLiveByMeeting.mockResolvedValue([EXPERT_PROVIDER_ROW]);
    mockListConnections.mockResolvedValue([{ id: 'conn-gone', endUserAccountId: 'eua-x' }]);
    const log = fakeLog();

    await withdrawMeetingCalendarProjection(
      { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: 'ep-1' },
      asLogger(log)
    );

    expect(mockDeleteConsultationEvent).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(mockSoftDeleteByMeetingAndParty).toHaveBeenCalledWith(MEETING_ID, 'expert');
  });

  /**
   * ⚠ "No vendor delete error on an already-deleted event", satisfied LITERALLY: a `not_found`
   * is an explicit SUCCESS, logged at `info`, mirroring `deleteRoom`'s 404 handling.
   */
  it('⚠ an ApirocError{kind:"not_found"} logs at INFO, not error, and raises no Sentry', async () => {
    mockListLiveByMeeting.mockResolvedValue([EXPERT_PROVIDER_ROW]);
    mockDeleteConsultationEvent.mockRejectedValue(
      new ApirocError({ kind: 'not_found', operation: 'events.delete', status: 404 })
    );
    const log = fakeLog();

    await withdrawMeetingCalendarProjection(
      { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: 'ep-1' },
      asLogger(log)
    );

    expect(log.error).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { meetingId: MEETING_ID },
      'Vendor calendar event already gone — treating the delete as done'
    );
  });

  it('a throwing vendor delete is logged at error, Sentried, and the rows still retire', async () => {
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ICS_ROW, EXPERT_PROVIDER_ROW]);
    mockDeleteConsultationEvent.mockRejectedValue(new Error('apiroc 500'));
    const log = fakeLog();

    await expect(
      withdrawMeetingCalendarProjection(
        { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: 'ep-1' },
        asLogger(log)
      )
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockSoftDeleteByMeetingAndParty).toHaveBeenCalledTimes(2);
  });
});

describe('withdrawMeetingCalendarProjection — never throws', () => {
  it('returns early, and Sentries, when the row read fails', async () => {
    mockListLiveByMeeting.mockRejectedValue(new Error('db down'));
    const log = fakeLog();

    await expect(
      withdrawMeetingCalendarProjection(
        { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: 'ep-1' },
        asLogger(log)
      )
    ).resolves.toBeUndefined();

    expect(mockPublishCancellation).not.toHaveBeenCalled();
    expect(mockSoftDeleteByMeetingAndParty).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('logs and returns when the meeting has no calendar row at all', async () => {
    mockListLiveByMeeting.mockResolvedValue([]);
    const log = fakeLog();

    await withdrawMeetingCalendarProjection(
      { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: 'ep-1' },
      asLogger(log)
    );

    expect(mockPublishCancellation).not.toHaveBeenCalled();
    expect(mockSoftDeleteByMeetingAndParty).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID },
      'Calendar withdrawal — no calendar row to withdraw'
    );
  });
});

/**
 * ⚠⚠ THE ONE THING THIS FUNCTION DOES **NOT** SWALLOW, AND THE BEHAVIOUR THAT FOLLOWS FROM IT.
 *
 * `publishCancellationCalendarWithdrawals`' own contract is already "never throws" (every
 * recipient publish is individually try/caught), so a rejection out of W1 is a CONTRACT
 * VIOLATION — and the right response to one is to stop BEFORE the retire, leaving the rows LIVE
 * and visible to reconciliation, rather than retiring a projection whose withdrawal was never
 * enqueued. Retiring anyway would be the permanent failure direction the whole publish-first
 * ordering exists to avoid.
 *
 * Both producers wrap this call as a backstop, and both have their own tests for that
 * (`routes/meetings/cancel.test.ts`, `services/meetings/meeting-availability.test.ts`).
 */
describe('withdrawMeetingCalendarProjection — the ONE propagating failure (W1)', () => {
  it('⚠⚠ a throwing publisher STOPS BEFORE the vendor delete and BEFORE the retire', async () => {
    mockListLiveByMeeting.mockResolvedValue([CLIENT_ICS_ROW, EXPERT_PROVIDER_ROW]);
    mockPublishCancellation.mockRejectedValue(new Error('contract violation'));

    await expect(
      withdrawMeetingCalendarProjection(
        { meetingId: MEETING_ID, cancelAuditId: CANCEL_AUDIT_ID, expertProfileId: 'ep-1' },
        asLogger(fakeLog())
      )
    ).rejects.toThrow('contract violation');

    // ⚠ THE POINT OF THE TEST: the rows stay LIVE. Nothing was retired, and the vendor event was
    // not deleted either — a projection whose withdrawal was never enqueued must not be retired.
    expect(mockDeleteConsultationEvent).not.toHaveBeenCalled();
    expect(mockSoftDeleteByMeetingAndParty).not.toHaveBeenCalled();
  });
});
