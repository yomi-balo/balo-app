import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const CONTEXT_ID = '22222222-2222-4222-8222-222222222222';
const EXPERT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const AUDIT_ID = '55555555-5555-4555-8555-555555555555';
const START = new Date('2026-09-07T09:00:00.000Z');
const END = new Date('2026-09-07T09:30:00.000Z');
const MOVED_START = new Date('2026-09-08T09:00:00.000Z');
const MOVED_END = new Date('2026-09-08T09:30:00.000Z');

const {
  mockQueueAdd,
  mockFindById,
  mockFindLatestAudit,
  mockFindLiveExpertProviderEvent,
  mockTrackServer,
  mockProject,
  mockRecordClient,
  mockLogOutcome,
  mockPublishInvites,
  mockWithdraw,
  mockEnqueueAmend,
  mockReportAmendFailure,
  mockRaiseAdminAlert,
  mockLog,
  workerCapture,
} = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockFindById: vi.fn(),
  mockFindLatestAudit: vi.fn(),
  mockFindLiveExpertProviderEvent: vi.fn(),
  mockTrackServer: vi.fn(),
  mockProject: vi.fn(),
  mockRecordClient: vi.fn(),
  mockLogOutcome: vi.fn(),
  mockPublishInvites: vi.fn(),
  mockWithdraw: vi.fn(),
  mockEnqueueAmend: vi.fn(),
  mockReportAmendFailure: vi.fn(),
  mockRaiseAdminAlert: vi.fn(),
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  workerCapture: {
    queueName: null as string | null,
    processor: null as ((job: unknown) => Promise<void>) | null,
    opts: null as Record<string, unknown> | null,
    handlers: {} as Record<string, (...args: unknown[]) => void>,
  },
}));

// The Worker mock captures its constructor args. Without a `bullmq` mock the real Worker would
// open a Redis connection and hang CI.
vi.mock('bullmq', () => ({
  Worker: class MockWorker {
    constructor(name: string, processor: (job: unknown) => Promise<void>, opts: unknown) {
      workerCapture.queueName = name;
      workerCapture.processor = processor;
      workerCapture.opts = opts as Record<string, unknown>;
    }
    on(event: string, handler: (...args: unknown[]) => void): void {
      workerCapture.handlers[event] = handler;
    }
  },
  Queue: class MockQueue {},
}));

vi.mock('../lib/redis.js', () => ({
  createRedisConnection: () => ({ mocked: 'connection' }),
}));

vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  getQueue: vi.fn(() => ({ add: mockQueueAdd })),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => mockLog,
}));

vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mockFindById },
  auditEventsRepository: { findLatestByEntityAndAction: mockFindLatestAudit },
  meetingCalendarEventsRepository: {
    findLiveExpertProviderEvent: mockFindLiveExpertProviderEvent,
  },
}));

vi.mock('@balo/analytics/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@balo/analytics/server')>()),
  trackServer: mockTrackServer,
}));

vi.mock('../services/consultation-events/booking-calendar-projection.js', () => ({
  projectBookingCalendarEvent: mockProject,
  recordClientCalendarEntry: mockRecordClient,
  logCalendarProjectionOutcome: mockLogOutcome,
}));

vi.mock('../services/calendar-invites/publish-calendar-invites.js', () => ({
  publishBookingCalendarInvites: mockPublishInvites,
}));

vi.mock('../services/meetings/withdraw-meeting-calendar.js', () => ({
  withdrawMeetingCalendarProjection: mockWithdraw,
}));

vi.mock('./meeting-calendar-amend.js', () => ({
  enqueueMeetingCalendarAmend: mockEnqueueAmend,
}));

vi.mock('../services/admin-alerts/raise.js', () => ({ raiseAdminAlert: mockRaiseAdminAlert }));

vi.mock('../services/meetings/meeting-availability.js', () => ({
  reportCalendarAmendEnqueueFailure: mockReportAmendFailure,
}));

import {
  BOOKING_CALENDAR_PROJECTION_QUEUE,
  bookingCalendarProjectionJobId,
  enqueueBookingCalendarProjection,
  processBookingCalendarProjection,
  startBookingCalendarProjectionWorker,
  type BookingCalendarProjectionJobData,
} from './booking-calendar-projection-job.js';

const DATA: BookingCalendarProjectionJobData = {
  meetingId: MEETING_ID,
  expertProfileId: EXPERT_ID,
  contextType: 'case',
  contextId: CONTEXT_ID,
  userId: USER_ID,
};

function meetingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEETING_ID,
    status: 'scheduled',
    scheduledStart: START,
    scheduledEnd: END,
    ...overrides,
  };
}

function jobOf(
  data: BookingCalendarProjectionJobData = DATA
): Job<BookingCalendarProjectionJobData> {
  return {
    id: bookingCalendarProjectionJobId(data.meetingId),
    data,
  } as Job<BookingCalendarProjectionJobData>;
}

const callOrder: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  workerCapture.processor = null;
  workerCapture.opts = null;
  workerCapture.queueName = null;
  workerCapture.handlers = {};

  mockFindById.mockResolvedValue(meetingRow());
  mockFindLatestAudit.mockResolvedValue({ id: AUDIT_ID });
  mockFindLiveExpertProviderEvent.mockResolvedValue({ id: 'provider-event' });
  mockProject.mockImplementation(async () => {
    callOrder.push('project');
    return 'provider_event';
  });
  mockRecordClient.mockImplementation(async () => {
    callOrder.push('client');
    return 'ics';
  });
  mockTrackServer.mockImplementation((_event: string, props: { party: string }) => {
    callOrder.push(`emit:${props.party}`);
  });
  mockPublishInvites.mockImplementation(async () => {
    callOrder.push('invites');
  });
  mockWithdraw.mockResolvedValue(undefined);
  mockEnqueueAmend.mockResolvedValue(undefined);
  mockReportAmendFailure.mockResolvedValue(undefined);
  mockRaiseAdminAlert.mockResolvedValue(undefined);
});

describe('enqueueBookingCalendarProjection', () => {
  it('adds one job with attempts 1, no backoff, and a colon-free per-meeting id', async () => {
    await enqueueBookingCalendarProjection(DATA);

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0] ?? [];
    expect(name).toBe('project-booking-calendar');
    expect(data).toEqual(DATA);
    expect(opts).toEqual({
      jobId: `booking-calendar-projection--${MEETING_ID}`,
      attempts: 1,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    });
    expect(opts).not.toHaveProperty('backoff');
    expect(opts.jobId).not.toContain(':');
  });

  it('carries no window in the payload', async () => {
    await enqueueBookingCalendarProjection(DATA);

    const [, data] = mockQueueAdd.mock.calls[0] ?? [];
    expect(Object.keys(data).sort()).toEqual([
      'contextId',
      'contextType',
      'expertProfileId',
      'meetingId',
      'userId',
    ]);
  });

  it('propagates an enqueue rejection so the caller can raise the alert', async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error('redis down'));

    await expect(enqueueBookingCalendarProjection(DATA)).rejects.toThrow('redis down');
  });
});

describe('startBookingCalendarProjectionWorker', () => {
  it('never re-runs a stalled job: maxStalledCount is 0', () => {
    startBookingCalendarProjectionWorker();

    expect(workerCapture.queueName).toBe(BOOKING_CALENDAR_PROJECTION_QUEUE);
    expect(workerCapture.opts).toMatchObject({ maxStalledCount: 0, concurrency: 2 });
    expect(workerCapture.processor).toBe(processBookingCalendarProjection);
  });

  it('logs a failed job at error with ids only', () => {
    startBookingCalendarProjectionWorker();

    workerCapture.handlers.failed?.({ data: DATA }, new Error('boom'));

    expect(mockLog.error).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, error: 'boom', stack: expect.any(String) },
      expect.stringContaining('not retried')
    );
  });

  it('logs a failed job whose record is gone', () => {
    startBookingCalendarProjectionWorker();

    workerCapture.handlers.failed?.(undefined, new Error('boom'));

    expect(mockLog.error).toHaveBeenCalledWith(
      { meetingId: undefined, error: 'boom', stack: expect.any(String) },
      expect.any(String)
    );
  });

  describe('the calendar.projection_failed alert', () => {
    const JOB_ID = bookingCalendarProjectionJobId(MEETING_ID);

    it('a job with no record raises nothing', () => {
      startBookingCalendarProjectionWorker();

      workerCapture.handlers.failed?.(undefined, new Error('boom'));

      expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
    });

    it('a stalled job tells ops it may have partly run, and how to re-drive it', () => {
      startBookingCalendarProjectionWorker();

      workerCapture.handlers.failed?.(
        { id: JOB_ID, data: DATA },
        new Error('job stalled more than allowable limit')
      );

      expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
      const [[input]] = mockRaiseAdminAlert.mock.calls;
      expect(input).toMatchObject({
        kind: 'calendar.projection_failed',
        entityType: 'meeting',
        entityId: MEETING_ID,
      });
      expect(input.detail.title).toBe('Calendar projection failed after a booking');
      expect(input.detail.entityLabel).toBe(`Meeting ${MEETING_ID}`);
      expect(input.detail.evidence).toContain('may have partly run');
      expect(input.detail.evidence).toContain("check the expert's calendar before re-driving");
      expect(input.detail.evidence).not.toContain('nothing ran');
      expect(input.detail.evidence).toContain(
        `\`job.retry()\` on the kept failed job \`${JOB_ID}\``
      );
      expect(input.detail.evidence).toContain('queue `booking-calendar-projection`');
      expect(input.detail.facts).toEqual([
        ['Meeting', MEETING_ID],
        ['Expert profile', EXPERT_ID],
        ['Job id', JOB_ID],
        ['Failure', 'stalled'],
      ]);
    });

    it('any other failure says nothing ran', () => {
      startBookingCalendarProjectionWorker();

      workerCapture.handlers.failed?.(
        { id: JOB_ID, data: { ...DATA, expertProfileId: null } },
        new Error('connect failed to https://db.internal/secret')
      );

      const [[input]] = mockRaiseAdminAlert.mock.calls;
      expect(input.detail.evidence).toContain('nothing ran');
      expect(input.detail.evidence).not.toContain('partly run');
      expect(input.detail.evidence).toContain('[redacted-url]');
      expect(input.detail.evidence).not.toContain('https://db.internal');
      expect(input.detail.facts).toEqual([
        ['Meeting', MEETING_ID],
        ['Expert profile', 'none'],
        ['Job id', JOB_ID],
        ['Failure', 'error'],
      ]);
    });

    it('falls back to the derived job id when the record carries none', () => {
      startBookingCalendarProjectionWorker();

      workerCapture.handlers.failed?.({ data: DATA }, new Error('boom'));

      const [[input]] = mockRaiseAdminAlert.mock.calls;
      expect(input.detail.facts).toContainEqual(['Job id', JOB_ID]);
    });

    it('swallows a throw from raising the alert and logs it', async () => {
      mockRaiseAdminAlert.mockRejectedValueOnce(new Error('queue down'));
      startBookingCalendarProjectionWorker();

      expect(() =>
        workerCapture.handlers.failed?.({ id: JOB_ID, data: DATA }, new Error('boom'))
      ).not.toThrow();
      await vi.waitFor(() => {
        expect(mockLog.error).toHaveBeenCalledWith(
          { meetingId: MEETING_ID, error: 'queue down', stack: expect.any(String) },
          'Could not raise the calendar.projection_failed alert'
        );
      });
    });
  });
});

describe('processBookingCalendarProjection — a live meeting', () => {
  it('runs project, expert emit, client row, client emit, then invites, in that order', async () => {
    await processBookingCalendarProjection(jobOf());

    expect(callOrder).toEqual(['project', 'emit:expert', 'client', 'emit:client', 'invites']);
  });

  it('emits both parties with the delivery each step returned', async () => {
    await processBookingCalendarProjection(jobOf());

    expect(mockTrackServer).toHaveBeenNthCalledWith(1, 'meeting_calendar_projected', {
      meeting_id: MEETING_ID,
      context_type: 'case',
      party: 'expert',
      delivery: 'provider_event',
      distinct_id: USER_ID,
    });
    expect(mockTrackServer).toHaveBeenNthCalledWith(2, 'meeting_calendar_projected', {
      meeting_id: MEETING_ID,
      context_type: 'case',
      party: 'client',
      delivery: 'ics',
      distinct_id: USER_ID,
    });
  });

  it('projects the re-read row window, not anything from the payload', async () => {
    await processBookingCalendarProjection(jobOf());

    const [subject, contextType, contextId] = mockProject.mock.calls[0] ?? [];
    expect(subject).toEqual({
      meeting: expect.objectContaining({ scheduledStart: START, scheduledEnd: END }),
      expertProfileId: EXPERT_ID,
    });
    expect(contextType).toBe('case');
    expect(contextId).toBe(CONTEXT_ID);
    expect(mockRecordClient).toHaveBeenCalledWith(
      MEETING_ID,
      'case',
      CONTEXT_ID,
      expect.anything()
    );
  });

  it('publishes the invites with the meeting, context and expert', async () => {
    await processBookingCalendarProjection(jobOf());

    expect(mockPublishInvites).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, contextType: 'case', expertProfileId: EXPERT_ID },
      expect.anything()
    );
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(mockEnqueueAmend).not.toHaveBeenCalled();
  });

  it('a throwing projection is reported as failed and the rest still runs', async () => {
    mockProject.mockRejectedValueOnce(new Error('contract violation'));

    await processBookingCalendarProjection(jobOf());

    expect(mockTrackServer).toHaveBeenNthCalledWith(
      1,
      'meeting_calendar_projected',
      expect.objectContaining({ party: 'expert', delivery: 'failed' })
    );
    expect(mockRecordClient).toHaveBeenCalledTimes(1);
    expect(mockPublishInvites).toHaveBeenCalledTimes(1);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ party: 'expert', deliveryMode: 'failed' }),
      expect.stringContaining('never-throws')
    );
  });

  it('a throwing invite publish is logged and swallowed', async () => {
    mockPublishInvites.mockRejectedValueOnce(new Error('contract violation'));

    await expect(processBookingCalendarProjection(jobOf())).resolves.toBeUndefined();

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, contextType: 'case' }),
      expect.stringContaining('invite publish threw')
    );
  });
});

describe('processBookingCalendarProjection — cancelled or removed before the job ran (P1)', () => {
  it.each([
    ['cancelled', meetingRow({ status: 'cancelled' })],
    ['missing or soft-deleted', undefined],
  ])('a %s meeting projects nothing and reports skipped for both parties', async (_label, row) => {
    mockFindById.mockResolvedValue(row);

    await processBookingCalendarProjection(jobOf());

    expect(mockProject).not.toHaveBeenCalled();
    expect(mockRecordClient).not.toHaveBeenCalled();
    expect(mockPublishInvites).not.toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(mockFindById).toHaveBeenCalledTimes(1);

    for (const party of ['expert', 'client']) {
      expect(mockLogOutcome).toHaveBeenCalledWith(
        {
          meetingId: MEETING_ID,
          party,
          contextType: 'case',
          contextId: CONTEXT_ID,
          deliveryMode: 'skipped',
        },
        expect.anything()
      );
      expect(mockTrackServer).toHaveBeenCalledWith('meeting_calendar_projected', {
        meeting_id: MEETING_ID,
        context_type: 'case',
        party,
        delivery: 'skipped',
        distinct_id: USER_ID,
      });
    }
    expect(mockTrackServer).toHaveBeenCalledTimes(2);
  });

  it('a throwing first read fails the job (kept, not retried)', async () => {
    mockFindById.mockRejectedValueOnce(new Error('db down'));

    await expect(processBookingCalendarProjection(jobOf())).rejects.toThrow('db down');

    expect(mockProject).not.toHaveBeenCalled();
  });
});

describe('processBookingCalendarProjection — cancelled while the job ran (P4a)', () => {
  it.each([
    ['cancelled', meetingRow({ status: 'cancelled' })],
    ['soft-deleted', undefined],
  ])(
    'a %s meeting is withdrawn with the cancel audit id and gets no invites',
    async (_l, second) => {
      mockFindById.mockResolvedValueOnce(meetingRow()).mockResolvedValueOnce(second);

      await processBookingCalendarProjection(jobOf());

      expect(mockFindLatestAudit).toHaveBeenCalledWith({
        entityType: 'meeting',
        entityId: MEETING_ID,
        action: 'meeting.cancelled',
      });
      expect(mockWithdraw).toHaveBeenCalledWith(
        { meetingId: MEETING_ID, cancelAuditId: AUDIT_ID, expertProfileId: EXPERT_ID },
        expect.anything()
      );
      expect(mockPublishInvites).not.toHaveBeenCalled();
    }
  );

  it('projected both parties before withdrawing', async () => {
    mockFindById
      .mockResolvedValueOnce(meetingRow())
      .mockResolvedValueOnce(meetingRow({ status: 'cancelled' }));

    await processBookingCalendarProjection(jobOf());

    expect(mockProject).toHaveBeenCalledTimes(1);
    expect(mockRecordClient).toHaveBeenCalledTimes(1);
  });

  it('no cancellation audit row means a warning, no withdrawal and no invites', async () => {
    mockFindById.mockResolvedValueOnce(meetingRow()).mockResolvedValueOnce(undefined);
    mockFindLatestAudit.mockResolvedValue(undefined);

    await processBookingCalendarProjection(jobOf());

    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(mockPublishInvites).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      { meetingId: MEETING_ID },
      expect.stringContaining('no cancellation audit row')
    );
  });

  it('a throwing withdrawal is swallowed and still sends no invites', async () => {
    mockFindById
      .mockResolvedValueOnce(meetingRow())
      .mockResolvedValueOnce(meetingRow({ status: 'cancelled' }));
    mockWithdraw.mockRejectedValueOnce(new Error('contract violation'));

    await expect(processBookingCalendarProjection(jobOf())).resolves.toBeUndefined();

    expect(mockLog.error).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, error: 'contract violation', stack: expect.any(String) },
      expect.stringContaining('withdrawal')
    );
    expect(mockPublishInvites).not.toHaveBeenCalled();
  });

  it('a throwing audit lookup is swallowed and still sends no invites', async () => {
    mockFindById
      .mockResolvedValueOnce(meetingRow())
      .mockResolvedValueOnce(meetingRow({ status: 'cancelled' }));
    mockFindLatestAudit.mockRejectedValueOnce(new Error('db down'));

    await expect(processBookingCalendarProjection(jobOf())).resolves.toBeUndefined();

    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(mockPublishInvites).not.toHaveBeenCalled();
  });
});

describe('processBookingCalendarProjection — the second read fails (P3)', () => {
  it('logs and falls through to the invites', async () => {
    mockFindById.mockResolvedValueOnce(meetingRow()).mockRejectedValueOnce(new Error('db blip'));
    mockFindLatestAudit.mockResolvedValue(undefined);

    await expect(processBookingCalendarProjection(jobOf())).resolves.toBeUndefined();

    expect(mockLog.error).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, error: 'db blip', stack: expect.any(String) },
      expect.stringContaining('Could not re-read')
    );
    expect(mockPublishInvites).toHaveBeenCalledTimes(1);
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(mockEnqueueAmend).not.toHaveBeenCalled();
  });

  it('still withdraws against a cancellation audit row, and publishes NO invites', async () => {
    mockFindById.mockResolvedValueOnce(meetingRow()).mockRejectedValueOnce(new Error('db blip'));

    await processBookingCalendarProjection(jobOf());

    expect(mockWithdraw).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, cancelAuditId: AUDIT_ID, expertProfileId: EXPERT_ID },
      expect.anything()
    );
    expect(mockPublishInvites).not.toHaveBeenCalled();
  });

  it('a failing audit lookup falls through to the invites without withdrawing', async () => {
    mockFindById.mockResolvedValueOnce(meetingRow()).mockRejectedValueOnce(new Error('db blip'));
    mockFindLatestAudit.mockRejectedValueOnce(new Error('db still down'));

    await expect(processBookingCalendarProjection(jobOf())).resolves.toBeUndefined();

    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(mockPublishInvites).toHaveBeenCalledTimes(1);
  });
});

describe('processBookingCalendarProjection — the window moved while the job ran (P4b)', () => {
  const movedRow = (): Record<string, unknown> =>
    meetingRow({ scheduledStart: MOVED_START, scheduledEnd: MOVED_END });

  it('enqueues the amend keyed on the projection job id and still publishes the invites', async () => {
    mockFindById.mockResolvedValueOnce(meetingRow()).mockResolvedValueOnce(movedRow());

    await processBookingCalendarProjection(jobOf());

    expect(mockFindLiveExpertProviderEvent).toHaveBeenCalledWith(MEETING_ID);
    expect(mockEnqueueAmend).toHaveBeenCalledWith(
      MEETING_ID,
      EXPERT_ID,
      `booking-calendar-projection--${MEETING_ID}`
    );
    expect(mockPublishInvites).toHaveBeenCalledTimes(1);
  });

  it('an end-only move also counts', async () => {
    mockFindById
      .mockResolvedValueOnce(meetingRow())
      .mockResolvedValueOnce(meetingRow({ scheduledEnd: MOVED_END }));

    await processBookingCalendarProjection(jobOf());

    expect(mockEnqueueAmend).toHaveBeenCalledTimes(1);
  });

  it('an unchanged window enqueues no amend and does not look for a provider row', async () => {
    mockFindById
      .mockResolvedValueOnce(meetingRow())
      .mockResolvedValueOnce(
        meetingRow({ scheduledStart: new Date(START), scheduledEnd: new Date(END) })
      );

    await processBookingCalendarProjection(jobOf());

    expect(mockFindLiveExpertProviderEvent).not.toHaveBeenCalled();
    expect(mockEnqueueAmend).not.toHaveBeenCalled();
  });

  it('no live provider row means no amend', async () => {
    mockFindById.mockResolvedValueOnce(meetingRow()).mockResolvedValueOnce(movedRow());
    mockFindLiveExpertProviderEvent.mockResolvedValue(undefined);

    await processBookingCalendarProjection(jobOf());

    expect(mockEnqueueAmend).not.toHaveBeenCalled();
    expect(mockPublishInvites).toHaveBeenCalledTimes(1);
  });

  it('a payload with no expert never amends', async () => {
    mockFindById.mockResolvedValueOnce(meetingRow()).mockResolvedValueOnce(movedRow());

    await processBookingCalendarProjection(jobOf({ ...DATA, expertProfileId: null }));

    expect(mockFindLiveExpertProviderEvent).not.toHaveBeenCalled();
    expect(mockEnqueueAmend).not.toHaveBeenCalled();
    expect(mockPublishInvites).toHaveBeenCalledWith(
      expect.objectContaining({ expertProfileId: null }),
      expect.anything()
    );
  });

  it('an amend enqueue rejection is reported through the shared helper and invites still publish', async () => {
    const failure = new Error('redis down');
    mockFindById.mockResolvedValueOnce(meetingRow()).mockResolvedValueOnce(movedRow());
    mockEnqueueAmend.mockRejectedValueOnce(failure);

    await processBookingCalendarProjection(jobOf());

    expect(mockReportAmendFailure).toHaveBeenCalledWith(
      {
        meetingId: MEETING_ID,
        expertProfileId: EXPERT_ID,
        newStart: MOVED_START,
        trigger: 'booking_projection',
        error: failure,
      },
      expect.anything()
    );
    expect(mockPublishInvites).toHaveBeenCalledTimes(1);
  });

  it('a failing provider-row lookup is logged, raises no alert, and invites still publish', async () => {
    mockFindById.mockResolvedValueOnce(meetingRow()).mockResolvedValueOnce(movedRow());
    mockFindLiveExpertProviderEvent.mockRejectedValueOnce(new Error('db blip'));

    await processBookingCalendarProjection(jobOf());

    expect(mockLog.error).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, error: 'db blip', stack: expect.any(String) },
      expect.stringContaining('provider event')
    );
    expect(mockEnqueueAmend).not.toHaveBeenCalled();
    expect(mockReportAmendFailure).not.toHaveBeenCalled();
    expect(mockPublishInvites).toHaveBeenCalledTimes(1);
  });
});
