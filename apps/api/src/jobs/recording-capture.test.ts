import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DailyApiError } from '../services/daily/errors.js';

const queueAdd = vi.hoisted(() => vi.fn());
const findById = vi.hoisted(() => vi.fn());
const listOpen = vi.hoisted(() => vi.fn());
const findCapturingForMeeting = vi.hoisted(() => vi.fn());
const insertCapturing = vi.hoisted(() => vi.fn());
const markFailed = vi.hoisted(() => vi.fn());
const countFailedByStage = vi.hoisted(() => vi.fn());
const startRoomRecording = vi.hoisted(() => vi.fn());
const stopRoomRecording = vi.hoisted(() => vi.fn());
const trackServer = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());

const wired = vi.hoisted(
  () =>
    ({ processor: undefined, failedHandler: undefined }) as {
      processor?: (job: unknown) => Promise<void>;
      failedHandler?: (job: unknown, err: Error) => void;
    }
);

const MockUnrecoverableError = vi.hoisted(
  () =>
    class extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'UnrecoverableError';
      }
    }
);

const WorkerMock = vi.hoisted(() =>
  vi.fn(function (_queue: string, processor: (job: unknown) => Promise<void>) {
    wired.processor = processor;
    return {
      on: (event: string, handler: (job: unknown, err: Error) => void) => {
        if (event === 'failed') {
          wired.failedHandler = handler;
        }
      },
    };
  })
);

vi.mock('../lib/queue.js', () => ({ getQueue: () => ({ add: queueAdd }) }));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: vi.fn(() => ({ conn: true })) }));
vi.mock('bullmq', () => ({ Worker: WorkerMock, UnrecoverableError: MockUnrecoverableError }));
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById },
  meetingPresenceRepository: { listOpen },
  meetingRecordingsRepository: {
    findCapturingForMeeting,
    insertCapturing,
    markFailed,
    countFailedByStage,
  },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer,
  RECORDING_SERVER_EVENTS: {
    RECORDING_STARTED: 'recording_started',
    RECORDING_READY: 'recording_ready',
    RECORDING_FAILED: 'recording_failed',
  },
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ error: logError, warn: logWarn, info: logInfo }),
}));
vi.mock('../services/daily/recordings.js', () => ({ startRoomRecording, stopRoomRecording }));

import {
  enqueueRecordingEnsure,
  enqueueRecordingStop,
  startRecordingCaptureWorker,
  RECORDING_CAPTURE_QUEUE,
  ATTEMPTS,
  MAX_DAILY_FAILURES_PER_MEETING,
} from './recording-capture.js';

const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const ROOM = 'balo-abc';
const ROW = { id: 'rec-1', meetingId: MEETING_ID };

function liveMeeting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: MEETING_ID, status: 'in_progress', dailyRoomName: ROOM, ...overrides };
}

describe('recording-capture job — enqueue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueueRecordingEnsure adds an "ensure" job keyed on meetingId + dedupeToken', async () => {
    await enqueueRecordingEnsure({
      meetingId: MEETING_ID,
      trigger: 'in_progress',
      dedupeToken: 'evt_1',
    });

    expect(queueAdd).toHaveBeenCalledWith(
      'ensure',
      { meetingId: MEETING_ID, trigger: 'in_progress' },
      {
        jobId: `recording-ensure--${MEETING_ID}--evt_1`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      }
    );
  });

  it('enqueueRecordingStop adds a "stop" job keyed on meetingId alone', async () => {
    await enqueueRecordingStop({ meetingId: MEETING_ID });

    expect(queueAdd).toHaveBeenCalledWith(
      'stop',
      { meetingId: MEETING_ID },
      {
        jobId: `recording-stop--${MEETING_ID}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      }
    );
  });

  it('exposes the queue name', () => {
    expect(RECORDING_CAPTURE_QUEUE).toBe('recording-capture');
  });
});

describe('recording-capture job — ensure handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Below the R2 threshold by default — individual tests override to exercise the breaker.
    countFailedByStage.mockResolvedValue(0);
    startRecordingCaptureWorker();
  });

  async function runEnsure(data: { meetingId: string; trigger: string }): Promise<void> {
    await wired.processor?.({ name: 'ensure', data });
  }

  it('no-ops when the meeting is absent/soft-deleted', async () => {
    findById.mockResolvedValue(undefined);
    await runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' });
    expect(listOpen).not.toHaveBeenCalled();
  });

  it.each(['ended', 'cancelled'])('no-ops when the meeting is terminal (%s)', async (status) => {
    findById.mockResolvedValue(liveMeeting({ status }));
    await runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' });
    expect(listOpen).not.toHaveBeenCalled();
  });

  it('no-ops when the meeting has no venue (dailyRoomName null)', async () => {
    findById.mockResolvedValue(liveMeeting({ dailyRoomName: null }));
    await runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' });
    expect(listOpen).not.toHaveBeenCalled();
  });

  it('no-ops when the meeting is not in_progress', async () => {
    findById.mockResolvedValue(liveMeeting({ status: 'waiting_for_participants' }));
    await runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' });
    expect(listOpen).not.toHaveBeenCalled();
  });

  it('does NOT start a recording into an empty room', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([]);
    await runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' });
    expect(findCapturingForMeeting).not.toHaveBeenCalled();
  });

  it('no-ops when a segment is already capturing', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue({ id: 'rec-existing' });
    await runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' });
    expect(insertCapturing).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ FIX ROUND 1 (F8) — a FRESH capturing row (created moments ago, `dailyRecordingId`
   * still `null` — the ordinary window between `insertCapturing` and the Daily call
   * returning) must stay a routine `log.info`, not an error. Only STALE rows in this shape
   * are the residual F8 makes observable.
   */
  it('a fresh capturing row with no dailyRecordingId yet logs at info, not error', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue({
      id: 'rec-existing',
      dailyRecordingId: null,
      createdAt: new Date(),
    });
    await runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' });
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, recordingId: 'rec-existing' }),
      expect.stringContaining('already_capturing')
    );
    expect(logError).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ FIX ROUND 1 (F8) — THE LOAD-BEARING CASE. A worker died between `insertCapturing` and
   * the Daily call; the row is old, `dailyRecordingId` is still `null`, and no Daily event
   * will ever advance it. This must be observable at `error`, not silently absorbed at `info`
   * — that silence is exactly what let the meeting record nothing with no signal anywhere.
   */
  it('⚠⚠ a STALE capturing row with no dailyRecordingId logs at ERROR — a worker likely died mid-start', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue({
      id: 'rec-stuck',
      dailyRecordingId: null,
      createdAt: new Date(Date.now() - 5 * 60_000),
    });
    await runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, recordingId: 'rec-stuck' }),
      expect.stringContaining('never acknowledged')
    );
    expect(insertCapturing).not.toHaveBeenCalled();
  });

  /**
   * ⚠ A stale row that already HAS a `dailyRecordingId` is genuinely capturing (Daily is mid
   * -segment) — age alone must never trip the error path.
   */
  it('a stale-but-otherwise-normal capturing row (has a dailyRecordingId) still logs at info', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue({
      id: 'rec-normal',
      dailyRecordingId: 'daily-rec-1',
      createdAt: new Date(Date.now() - 5 * 60_000),
    });
    await runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' });
    expect(logError).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, recordingId: 'rec-normal' }),
      expect.stringContaining('already_capturing')
    );
  });

  /**
   * ⚠⚠ FIX ROUND 2 (R2) — THE CIRCUIT BREAKER. `routes/daily/webhook.ts` re-arms
   * `enqueueRecordingEnsure` unconditionally after every `recording.error`; for a
   * persistently-broken room that would otherwise re-attempt (and re-fail) for the rest of
   * the meeting. At the threshold, `handleEnsure` must refuse to insert a fresh capturing row
   * or call Daily at all.
   */
  it('⚠⚠ AT the failure threshold: refuses to re-arm, logs at error, and calls Daily nothing', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue(undefined);
    countFailedByStage.mockResolvedValue(MAX_DAILY_FAILURES_PER_MEETING);

    await runEnsure({ meetingId: MEETING_ID, trigger: 'rejoin' });

    expect(countFailedByStage).toHaveBeenCalledWith(MEETING_ID, 'daily');
    expect(insertCapturing).not.toHaveBeenCalled();
    expect(startRoomRecording).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        dailyFailures: MAX_DAILY_FAILURES_PER_MEETING,
      }),
      expect.stringContaining('repeatedly')
    );
  });

  /**
   * ⚠⚠ FIX ROUND 2 (F3a) — THE COLLISION THIS CONSTANT EXISTS TO AVOID, PINNED.
   * §5.1b stamps a `failed` row on EVERY BullMQ attempt, so a cap equal to `ATTEMPTS` is
   * consumed entirely by ONE exhausted retry sequence — a single transient Daily blip would
   * then disable recording for the rest of the meeting, refusing every later rejoin re-arm.
   * A strict `>` is the whole property; without it the breaker fires on recoverable faults.
   */
  it('⚠⚠ the cap leaves room beyond one full retry sequence (cap > ATTEMPTS)', () => {
    expect(MAX_DAILY_FAILURES_PER_MEETING).toBeGreaterThan(ATTEMPTS);
  });

  it('BELOW the failure threshold: the re-arm still starts a fresh capture', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue(undefined);
    countFailedByStage.mockResolvedValue(MAX_DAILY_FAILURES_PER_MEETING - 1);
    insertCapturing.mockResolvedValue(ROW);
    startRoomRecording.mockResolvedValue(undefined);

    await runEnsure({ meetingId: MEETING_ID, trigger: 'rejoin' });

    expect(insertCapturing).toHaveBeenCalled();
    expect(startRoomRecording).toHaveBeenCalledWith(ROOM, { instanceId: ROW.id });
  });

  it('⚠ a concurrent duplicate loses the unique index and does nothing', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue(undefined);
    insertCapturing.mockResolvedValue(undefined);
    await runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' });
    expect(startRoomRecording).not.toHaveBeenCalled();
  });

  it('the happy path inserts then calls start with instanceId === row.id', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue(undefined);
    insertCapturing.mockResolvedValue(ROW);
    startRoomRecording.mockResolvedValue(undefined);

    await runEnsure({ meetingId: MEETING_ID, trigger: 'rejoin' });

    expect(startRoomRecording).toHaveBeenCalledWith(ROOM, { instanceId: ROW.id });
    expect(trackServer).toHaveBeenCalledWith('recording_started', {
      meeting_id: MEETING_ID,
      trigger: 'rejoin',
      distinct_id: MEETING_ID,
    });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('⚠⚠ a start failure stamps `failed` with stage "daily" BEFORE rethrowing', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue(undefined);
    insertCapturing.mockResolvedValue(ROW);
    startRoomRecording.mockRejectedValue(
      new DailyApiError('POST', '/rooms/x/recordings/start', 429, 'rate limited')
    );

    await expect(runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' })).rejects.toThrow();

    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: ROW.id, stage: 'daily' })
    );
  });

  it('a non-429 4xx becomes UnrecoverableError', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue(undefined);
    insertCapturing.mockResolvedValue(ROW);
    startRoomRecording.mockRejectedValue(new DailyApiError('POST', '/x', 400, 'bad body'));

    await expect(
      runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' })
    ).rejects.toBeInstanceOf(MockUnrecoverableError);
  });

  it('a 429 rethrows the ORIGINAL error (retryable)', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue(undefined);
    insertCapturing.mockResolvedValue(ROW);
    const err = new DailyApiError('POST', '/x', 429, 'rate limited');
    startRoomRecording.mockRejectedValue(err);

    await expect(runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' })).rejects.toBe(err);
  });
});

describe('recording-capture job — stop handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startRecordingCaptureWorker();
  });

  async function runStop(data: { meetingId: string }): Promise<void> {
    await wired.processor?.({ name: 'stop', data });
  }

  it('succeeds with no vendor call when there is nothing capturing', async () => {
    findById.mockResolvedValue(liveMeeting());
    findCapturingForMeeting.mockResolvedValue(undefined);

    await runStop({ meetingId: MEETING_ID });

    expect(stopRoomRecording).not.toHaveBeenCalled();
  });

  it('succeeds when the meeting is absent', async () => {
    findById.mockResolvedValue(undefined);
    await runStop({ meetingId: MEETING_ID });
    expect(findCapturingForMeeting).not.toHaveBeenCalled();
  });

  it('succeeds when the meeting has no venue', async () => {
    findById.mockResolvedValue(liveMeeting({ dailyRoomName: null }));
    await runStop({ meetingId: MEETING_ID });
    expect(findCapturingForMeeting).not.toHaveBeenCalled();
  });

  it('requests the stop for the capturing row', async () => {
    findById.mockResolvedValue(liveMeeting());
    findCapturingForMeeting.mockResolvedValue(ROW);
    stopRoomRecording.mockResolvedValue('stopped');

    await runStop({ meetingId: MEETING_ID });

    expect(stopRoomRecording).toHaveBeenCalledWith(ROOM, { instanceId: ROW.id });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('⚠ never stamps the row, even on a "nothing_to_stop" outcome', async () => {
    findById.mockResolvedValue(liveMeeting());
    findCapturingForMeeting.mockResolvedValue(ROW);
    stopRoomRecording.mockResolvedValue('nothing_to_stop');

    await runStop({ meetingId: MEETING_ID });

    expect(markFailed).not.toHaveBeenCalled();
  });

  it('rethrows a 500 (retryable)', async () => {
    findById.mockResolvedValue(liveMeeting());
    findCapturingForMeeting.mockResolvedValue(ROW);
    stopRoomRecording.mockRejectedValue(new DailyApiError('POST', '/x', 500, 'boom'));

    await expect(runStop({ meetingId: MEETING_ID })).rejects.toBeInstanceOf(DailyApiError);
  });
});

describe('recording-capture job — worker.on("failed")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startRecordingCaptureWorker();
  });

  it('is a no-op when there is no job', () => {
    expect(() => wired.failedHandler?.(null, new Error('x'))).not.toThrow();
    expect(trackServer).not.toHaveBeenCalled();
  });

  it('waits for BullMQ to retry while attempts remain', () => {
    wired.failedHandler?.(
      { name: 'ensure', data: { meetingId: MEETING_ID }, opts: { attempts: 3 }, attemptsMade: 1 },
      new Error('boom')
    );
    expect(trackServer).not.toHaveBeenCalled();
  });

  it('emits recording_failed on exhausted "ensure" retries and does NOT stamp the row', () => {
    wired.failedHandler?.(
      { name: 'ensure', data: { meetingId: MEETING_ID }, opts: { attempts: 3 }, attemptsMade: 3 },
      new Error('boom')
    );
    expect(trackServer).toHaveBeenCalledWith('recording_failed', {
      meeting_id: MEETING_ID,
      stage: 'daily',
      reason: 'daily_api_error',
      distinct_id: MEETING_ID,
    });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('"stop" terminal failure logs only — no analytics, no stamp', () => {
    wired.failedHandler?.(
      { name: 'stop', data: { meetingId: MEETING_ID }, opts: { attempts: 3 }, attemptsMade: 3 },
      new Error('boom')
    );
    expect(trackServer).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('is terminal immediately for an UnrecoverableError, even at attemptsMade=1', () => {
    wired.failedHandler?.(
      { name: 'ensure', data: { meetingId: MEETING_ID }, opts: { attempts: 3 }, attemptsMade: 1 },
      new MockUnrecoverableError('bad body')
    );
    expect(trackServer).toHaveBeenCalledWith(
      'recording_failed',
      expect.objectContaining({ meeting_id: MEETING_ID })
    );
  });
});
