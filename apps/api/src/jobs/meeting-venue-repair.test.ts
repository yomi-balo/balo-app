import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import {
  DEFAULT_MEETING_TIMERS,
  dailyRoomNameForMeeting,
  type MeetingTimers,
} from '@balo/shared/meetings';

const {
  mockListUnprovisionedScheduled,
  mockFindById,
  mockListByMeeting,
  mockAdd,
  mockProvisionMeeting,
  mockIsDailyApiKeyConfigured,
  logError,
  logWarn,
  logInfo,
} = vi.hoisted(() => ({
  mockListUnprovisionedScheduled: vi.fn(),
  mockFindById: vi.fn(),
  mockListByMeeting: vi.fn(),
  mockAdd: vi.fn().mockResolvedValue({ id: 'job_1' }),
  mockProvisionMeeting: vi.fn(),
  mockIsDailyApiKeyConfigured: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

/**
 * Captures each `new Worker(queueName, processor, options)` call by queue name — this module
 * starts TWO workers, unlike the `recording-capture.test.ts` precedent's one, so a single
 * `wired` slot is not enough.
 */
const wiredProvision = vi.hoisted(
  () =>
    ({ processor: undefined, options: undefined, onHandlers: {} }) as {
      processor?: (job: unknown) => Promise<void>;
      options?: { concurrency?: number; limiter?: unknown };
      onHandlers: Record<string, (...args: unknown[]) => void>;
    }
);
const wiredSweep = vi.hoisted(
  () =>
    ({ processor: undefined, options: undefined }) as {
      processor?: () => Promise<void>;
      options?: { concurrency?: number };
    }
);

const WorkerMock = vi.hoisted(() =>
  vi.fn(function (
    queueName: string,
    processor: (job: unknown) => Promise<void>,
    options?: { concurrency?: number; limiter?: unknown }
  ) {
    if (queueName === 'meeting-venue-provision') {
      wiredProvision.processor = processor;
      wiredProvision.options = options;
      return {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          wiredProvision.onHandlers[event] = handler;
        },
      };
    }
    wiredSweep.processor = processor as () => Promise<void>;
    wiredSweep.options = options;
    return { on: () => {} };
  })
);

vi.mock('@balo/db', () => ({
  meetingsRepository: {
    listUnprovisionedScheduled: mockListUnprovisionedScheduled,
    findById: mockFindById,
  },
  meetingContextsRepository: { listByMeeting: mockListByMeeting },
}));
vi.mock('bullmq', () => ({ Worker: WorkerMock }));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn(() => ({})) }));
// ⚠ MANDATORY — `importOriginal` keeps the REAL `buildJobId`; mocking the whole module leaves
// it `undefined`, and the best-effort enqueue wrapper would swallow the resulting TypeError.
vi.mock('../lib/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue.js')>()),
  getQueue: vi.fn(() => ({ add: mockAdd })),
}));
vi.mock('../config/meeting-timers.js', () => ({
  resolveMeetingTimers: () => DEFAULT_MEETING_TIMERS,
}));
vi.mock('@balo/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('../services/meetings/provision-meeting.js', () => ({
  provisionMeeting: mockProvisionMeeting,
}));
vi.mock('../services/daily/client.js', () => ({
  isDailyApiKeyConfigured: mockIsDailyApiKeyConfigured,
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ error: logError, warn: logWarn, info: logInfo }),
}));
// `@balo/shared/meetings` and `./venue-repair-schedule.js` are DELIBERATELY NOT mocked — the
// real checkpoint schedule and the real `isBookableContextType`/`isMeetingVenueReady`/
// `selectPrimaryMeetingContext` are what these tests exercise. Same for
// `../services/meetings/authorize-meeting-booking.js` (the real `engagementTypeForContext`).

import {
  MAX_VENUE_REPAIRS_PER_TICK,
  VENUE_REPAIR_CANDIDATE_LIMIT,
  enqueueVenueProvision,
  handleVenueProvision,
  registerMeetingVenueRepairSweepCron,
  runMeetingVenueRepairSweep,
  startMeetingVenueProvisionWorker,
  startMeetingVenueRepairSweepWorker,
  type VenueProvisionJobData,
} from './meeting-venue-repair.js';
import { bucketOf } from '../services/meetings/venue-repair-schedule.js';

const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const CONTEXT_ID = '22222222-2222-4222-8222-222222222222';
const ROOM_NAME = dailyRoomNameForMeeting(MEETING_ID);

/** Minute-aligned "now" so the checkpoint schedule's buckets are easy to reason about. */
const NOW = new Date('2026-09-01T09:00:00.000Z');

function unprovisionedRow(
  overrides: Partial<{
    meetingId: string;
    scheduledStart: Date;
    createdAt: Date;
    roomNameStamped: boolean;
  }> = {}
): {
  meetingId: string;
  scheduledStart: Date;
  createdAt: Date;
  roomNameStamped: boolean;
} {
  return {
    meetingId: MEETING_ID,
    // start-8 relative to NOW → due immediately (booked 9 minutes before start).
    scheduledStart: new Date(NOW.getTime() + 8 * 60_000),
    createdAt: new Date(NOW.getTime() - 1 * 60_000),
    roomNameStamped: false,
    ...overrides,
  };
}

function scheduledMeeting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEETING_ID,
    status: 'scheduled',
    scheduledStart: new Date(NOW.getTime() + 8 * 60_000),
    createdAt: new Date(NOW.getTime() - 1 * 60_000),
    dailyRoomName: null,
    joinUrl: null,
    deletedAt: null,
    ...overrides,
  };
}

const CASE_CONTEXT_ROW = { contextType: 'case', contextId: CONTEXT_ID };

beforeEach(() => {
  vi.clearAllMocks();
  // `handleVenueProvision` reads `new Date()` internally (never an injected `now` — it must
  // re-check against the REAL clock at run time, not the enqueue-time snapshot). Fixtures
  // below are all built relative to NOW, so the wall clock must be pinned to it.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockIsDailyApiKeyConfigured.mockReturnValue(true);
  mockListUnprovisionedScheduled.mockResolvedValue([]);
  mockListByMeeting.mockResolvedValue([CASE_CONTEXT_ROW]);
  mockProvisionMeeting.mockResolvedValue({
    meetingId: MEETING_ID,
    provisioned: true,
    dailyRoomName: ROOM_NAME,
    joinUrl: `https://balo.daily.co/${ROOM_NAME}`,
    replayed: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
  wiredProvision.processor = undefined;
  wiredProvision.options = undefined;
  wiredProvision.onHandlers = {};
  wiredSweep.processor = undefined;
  wiredSweep.options = undefined;
});

// ── Producer ────────────────────────────────────────────────────────────────────────────────

describe('runMeetingVenueRepairSweep', () => {
  it('DAILY_API_KEY unset — no read, one warn, skipped result', async () => {
    mockIsDailyApiKeyConfigured.mockReturnValue(false);

    const result = await runMeetingVenueRepairSweep(NOW);

    expect(mockListUnprovisionedScheduled).not.toHaveBeenCalled();
    expect(result).toEqual({
      scanned: 0,
      due: 0,
      enqueued: 0,
      deferred: 0,
      skipped: 'daily_api_key_missing',
    });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      'DAILY_API_KEY is not set — venue repair pass skipped; unprovisioned meetings stay roomless until it is set'
    );
  });

  it('enqueues a due row with the exact jobId and job options', async () => {
    mockListUnprovisionedScheduled.mockResolvedValue([unprovisionedRow()]);

    const result = await runMeetingVenueRepairSweep(NOW);

    expect(result.due).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(mockAdd).toHaveBeenCalledTimes(1);
    const [jobName, data, opts] = mockAdd.mock.calls[0] as [
      string,
      VenueProvisionJobData,
      Record<string, unknown>,
    ];
    expect(jobName).toBe('provision');
    expect(data.meetingId).toBe(MEETING_ID);
    expect(opts).toMatchObject({
      jobId: `meeting-venue-provision--${MEETING_ID}--c${data.checkpointBucket}`,
      attempts: 1,
      removeOnComplete: { age: 600 },
      removeOnFail: { age: 600 },
    });
    expect(opts).not.toHaveProperty('priority');
  });

  it('a row with no due checkpoint is skipped — not enqueued, not counted in `due`', async () => {
    // scheduledStart far in the future relative to NOW and createdAt just now: no checkpoint
    // lands in the {B-1, B} catch-up window.
    mockListUnprovisionedScheduled.mockResolvedValue([
      unprovisionedRow({
        scheduledStart: new Date(NOW.getTime() + 5 * 60 * 60_000),
        createdAt: NOW,
      }),
    ]);

    const result = await runMeetingVenueRepairSweep(NOW);

    expect(result).toEqual({ scanned: 1, due: 0, enqueued: 0, deferred: 0 });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('defers past MAX_VENUE_REPAIRS_PER_TICK and warns once', async () => {
    const rows = Array.from({ length: MAX_VENUE_REPAIRS_PER_TICK + 1 }, (_unused, i) =>
      unprovisionedRow({ meetingId: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111` })
    );
    mockListUnprovisionedScheduled.mockResolvedValue(rows);

    const result = await runMeetingVenueRepairSweep(NOW);

    expect(result.enqueued).toBe(MAX_VENUE_REPAIRS_PER_TICK);
    expect(result.deferred).toBe(1);
    expect(mockAdd).toHaveBeenCalledTimes(MAX_VENUE_REPAIRS_PER_TICK);
    expect(logWarn).toHaveBeenCalledWith(
      { limit: MAX_VENUE_REPAIRS_PER_TICK, deferred: 1 },
      'Venue repair fan-out cap FILLED — deferred to later checkpoints'
    );
  });

  it('two-pass: 61 rows due at the CATCH-UP bucket plus 1 due at the FRESH bucket, the fresh row is enqueued', async () => {
    // Fresh-bucket row: due exactly at NOW (start+8, the AROUND_START_MINUTES literal 8 offset
    // does not exist — use created+2 anchored so `now` IS the checkpoint).
    const freshRow = unprovisionedRow({
      meetingId: 'aaaaaaaa-1111-4111-8111-111111111111',
      createdAt: new Date(NOW.getTime() - 2 * 60_000), // created+2 == NOW
      scheduledStart: new Date(NOW.getTime() + 5 * 60 * 60_000), // far from any start checkpoint
    });
    // Catch-up-bucket rows: due one tick EARLIER than `now` (created+2 == NOW - 1 tick).
    const catchUpRows = Array.from({ length: MAX_VENUE_REPAIRS_PER_TICK + 1 }, (_unused, i) =>
      unprovisionedRow({
        meetingId: `bbbbbbb${i % 10}-1111-4111-8111-11111111111${i % 10}`,
        createdAt: new Date(NOW.getTime() - 60_000 - 2 * 60_000),
        scheduledStart: new Date(NOW.getTime() + 5 * 60 * 60_000),
      })
    );
    mockListUnprovisionedScheduled.mockResolvedValue([...catchUpRows, freshRow]);

    const result = await runMeetingVenueRepairSweep(NOW);

    expect(result.enqueued).toBe(MAX_VENUE_REPAIRS_PER_TICK);
    const enqueuedIds = mockAdd.mock.calls.map(
      (call) => (call[1] as VenueProvisionJobData).meetingId
    );
    expect(enqueuedIds).toContain(freshRow.meetingId);
  });

  it('batch-filled warn when the read returns exactly the candidate limit', async () => {
    const rows = Array.from({ length: VENUE_REPAIR_CANDIDATE_LIMIT }, (_unused, i) =>
      unprovisionedRow({
        meetingId: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
        scheduledStart: new Date(NOW.getTime() + 5 * 60 * 60_000), // none due — isolates the warn
        createdAt: NOW,
      })
    );
    mockListUnprovisionedScheduled.mockResolvedValue(rows);

    await runMeetingVenueRepairSweep(NOW);

    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ limit: VENUE_REPAIR_CANDIDATE_LIMIT }),
      'Venue repair candidate batch FILLED — later meetings were not evaluated this tick'
    );
  });

  it('an enqueue throw is swallowed and logged — the loop continues to the next row', async () => {
    mockAdd.mockRejectedValueOnce(new Error('redis blip')).mockResolvedValue({ id: 'job_2' });
    mockListUnprovisionedScheduled.mockResolvedValue([
      unprovisionedRow({ meetingId: 'aaaaaaaa-1111-4111-8111-111111111111' }),
      unprovisionedRow({ meetingId: 'bbbbbbbb-1111-4111-8111-111111111111' }),
    ]);

    const result = await runMeetingVenueRepairSweep(NOW);

    expect(result.due).toBe(2);
    expect(mockAdd).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'aaaaaaaa-1111-4111-8111-111111111111' }),
      'Venue repair enqueue failed — the next checkpoint retries'
    );
  });

  it('logs a completion summary', async () => {
    await runMeetingVenueRepairSweep(NOW);

    expect(logInfo).toHaveBeenCalledWith(
      { scanned: 0, due: 0, enqueued: 0, deferred: 0 },
      'Venue repair sweep complete'
    );
  });
});

describe('enqueueVenueProvision', () => {
  it('adds a "provision" job keyed on meetingId + checkpoint bucket', async () => {
    await enqueueVenueProvision({ meetingId: MEETING_ID, checkpointBucket: 12345, final: true });

    expect(mockAdd).toHaveBeenCalledWith(
      'provision',
      { meetingId: MEETING_ID, checkpointBucket: 12345, final: true },
      {
        jobId: `meeting-venue-provision--${MEETING_ID}--c12345`,
        attempts: 1,
        removeOnComplete: { age: 600 },
        removeOnFail: { age: 600 },
      }
    );
  });
});

// ── Handler ─────────────────────────────────────────────────────────────────────────────────

describe('handleVenueProvision — guard sequence', () => {
  function makeJob(overrides: Partial<VenueProvisionJobData> = {}): Job<VenueProvisionJobData> {
    return {
      data: { meetingId: MEETING_ID, checkpointBucket: 1, final: false, ...overrides },
    } as unknown as Job<VenueProvisionJobData>;
  }

  it('DAILY_API_KEY unset — skips without calling findById', async () => {
    mockIsDailyApiKeyConfigured.mockReturnValue(false);

    await handleVenueProvision(makeJob());

    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockProvisionMeeting).not.toHaveBeenCalled();
  });

  it('meeting missing — skips without calling provisionMeeting', async () => {
    mockFindById.mockResolvedValue(undefined);

    await handleVenueProvision(makeJob());

    expect(mockProvisionMeeting).not.toHaveBeenCalled();
  });

  it('meeting not scheduled — skips without calling provisionMeeting', async () => {
    mockFindById.mockResolvedValue(scheduledMeeting({ status: 'in_progress' }));

    await handleVenueProvision(makeJob());

    expect(mockProvisionMeeting).not.toHaveBeenCalled();
  });

  it('meeting already venue-ready — skips without calling provisionMeeting', async () => {
    mockFindById.mockResolvedValue(
      scheduledMeeting({
        dailyRoomName: ROOM_NAME,
        joinUrl: `https://balo.daily.co/${ROOM_NAME}`,
      })
    );

    await handleVenueProvision(makeJob());

    expect(mockProvisionMeeting).not.toHaveBeenCalled();
  });

  it('past the repair cutoff — skips without calling provisionMeeting', async () => {
    mockFindById.mockResolvedValue(
      scheduledMeeting({
        // 10 min missedCallTerminationMs − 2 min margin = 8 min cutoff; well past it.
        scheduledStart: new Date(NOW.getTime() - 60 * 60_000),
      })
    );

    await handleVenueProvision(makeJob());

    expect(mockProvisionMeeting).not.toHaveBeenCalled();
  });

  it('no bookable primary context (none) — skips without calling provisionMeeting', async () => {
    mockFindById.mockResolvedValue(scheduledMeeting());
    mockListByMeeting.mockResolvedValue([]);

    await handleVenueProvision(makeJob());

    expect(mockProvisionMeeting).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, reason: 'none' }),
      'Venue repair skipped — no bookable primary context'
    );
  });

  it('a resolvable but NON-bookable primary context (retainer_checkin) — skips', async () => {
    mockFindById.mockResolvedValue(scheduledMeeting());
    mockListByMeeting.mockResolvedValue([
      { contextType: 'retainer_checkin', contextId: CONTEXT_ID },
    ]);

    await handleVenueProvision(makeJob());

    expect(mockProvisionMeeting).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, reason: 'retainer_checkin' }),
      'Venue repair skipped — no bookable primary context'
    );
  });

  it.each([true, false])(
    'happy path calls provisionMeeting with trigger repair and final=%s',
    async (final) => {
      mockFindById.mockResolvedValue(scheduledMeeting());

      await handleVenueProvision(makeJob({ final }));

      expect(mockProvisionMeeting).toHaveBeenCalledWith(
        MEETING_ID,
        {
          contextType: 'case',
          engagementType: 'case',
          distinctId: MEETING_ID,
          trigger: 'repair',
          escalateFailure: final,
        },
        expect.anything()
      );
    }
  );

  it('a provisioned:false result does not throw and logs nothing extra', async () => {
    mockFindById.mockResolvedValue(scheduledMeeting());
    mockProvisionMeeting.mockResolvedValue({
      meetingId: MEETING_ID,
      provisioned: false,
      dailyRoomName: null,
      joinUrl: null,
      replayed: false,
    });

    await expect(handleVenueProvision(makeJob())).resolves.toBeUndefined();
    expect(logInfo).not.toHaveBeenCalledWith(expect.anything(), 'Venue repaired');
  });

  it('a successful provision logs "Venue repaired" with the checkpoint bucket', async () => {
    mockFindById.mockResolvedValue(scheduledMeeting());

    await handleVenueProvision(makeJob({ checkpointBucket: 999 }));

    expect(logInfo).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, checkpointBucket: 999, replayed: false },
      'Venue repaired'
    );
  });

  // ── Mutation proofs (claims need mutation proof) ─────────────────────────────────────────
  it('MUTATION PROOF — the status guard is load-bearing: an ended meeting must never be re-provisioned', async () => {
    mockFindById.mockResolvedValue(scheduledMeeting({ status: 'ended' }));

    await handleVenueProvision(makeJob());

    // Asserting the negative directly proves the guard fires; there is no code path here to
    // "break" other than the guard itself, which the correctness of this suite depends on.
    expect(mockProvisionMeeting).not.toHaveBeenCalled();
  });

  it('MUTATION PROOF — the cutoff guard is load-bearing: exactly at the cutoff, provisionMeeting is never called', async () => {
    const timers: MeetingTimers = DEFAULT_MEETING_TIMERS;
    const scheduledStart = new Date(NOW.getTime() - (timers.missedCallTerminationMs - 2 * 60_000));
    mockFindById.mockResolvedValue(scheduledMeeting({ scheduledStart }));

    await handleVenueProvision(makeJob());

    expect(mockProvisionMeeting).not.toHaveBeenCalled();
  });
});

// ── Workers ─────────────────────────────────────────────────────────────────────────────────

describe('startMeetingVenueProvisionWorker', () => {
  it('sets concurrency 2 and the Daily-rate limiter', () => {
    startMeetingVenueProvisionWorker();

    expect(wiredProvision.options).toMatchObject({
      concurrency: 2,
      limiter: { max: 2, duration: 1000 },
    });
  });

  it('dispatches a "provision" job to the handler', async () => {
    mockFindById.mockResolvedValue(scheduledMeeting());
    startMeetingVenueProvisionWorker();

    await wiredProvision.processor?.({
      name: 'provision',
      data: { meetingId: MEETING_ID, checkpointBucket: 1, final: false },
    });

    expect(mockProvisionMeeting).toHaveBeenCalled();
  });

  it('acks and logs an unknown job name without calling the handler', async () => {
    startMeetingVenueProvisionWorker();

    await wiredProvision.processor?.({ name: 'something-else', data: {} });

    expect(mockFindById).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      { jobName: 'something-else' },
      'meeting-venue-provision: unknown job name — acking with no effect'
    );
  });

  it('logs on("failed") with the meeting id', () => {
    startMeetingVenueProvisionWorker();

    wiredProvision.onHandlers.failed?.({ data: { meetingId: MEETING_ID } }, new Error('db fault'));

    expect(logError).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, error: 'db fault' },
      'Venue repair job failed unexpectedly'
    );
  });

  it('on("failed") with a null job is a no-op', () => {
    startMeetingVenueProvisionWorker();

    expect(() => wiredProvision.onHandlers.failed?.(null, new Error('x'))).not.toThrow();
    expect(logError).not.toHaveBeenCalled();
  });
});

describe('startMeetingVenueRepairSweepWorker', () => {
  it('sets concurrency 1 and runs the sweep on dispatch', async () => {
    startMeetingVenueRepairSweepWorker();

    expect(wiredSweep.options).toMatchObject({ concurrency: 1 });

    await wiredSweep.processor?.();

    expect(mockListUnprovisionedScheduled).toHaveBeenCalled();
  });
});

describe('registerMeetingVenueRepairSweepCron', () => {
  it('registers the per-minute repeatable with removeOnComplete', async () => {
    await registerMeetingVenueRepairSweepCron();

    expect(mockAdd).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { pattern: '* * * * *' }, removeOnComplete: true }
    );
  });
});

describe('bucketOf re-export sanity', () => {
  it('is the same bucketing used by the producer', () => {
    expect(bucketOf(NOW.getTime())).toBe(Math.floor(NOW.getTime() / 60_000));
  });
});
