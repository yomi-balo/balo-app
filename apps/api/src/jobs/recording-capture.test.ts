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
vi.mock('../services/daily/recordings.js', () => ({
  startRoomRecording,
  stopRoomRecording,
  MIN_IDLE_TIMEOUT_SECONDS: 60,
}));

import {
  enqueueRecordingEnsure,
  enqueueRecordingStop,
  startRecordingCaptureWorker,
  RECORDING_CAPTURE_QUEUE,
  ATTEMPTS,
  MAX_DAILY_FAILURES_PER_MEETING,
  STUCK_CAPTURE_THRESHOLD_MS,
} from './recording-capture.js';

const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const ROOM = 'balo-abc';
const ROW = { id: 'rec-1', meetingId: MEETING_ID };
const STUCK_ID = 'rec-stuck';

function liveMeeting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: MEETING_ID, status: 'in_progress', dailyRoomName: ROOM, ...overrides };
}

/** How the five reap tests differ from one another — everything else is identical. */
interface StuckCaptureArrangement {
  /** `false` ⇒ `markFailed` resolves `undefined`: the reap's CAS lost. */
  readonly reapWins?: boolean;
  /** What `countFailedByStage` reports at step 5.5. */
  readonly dailyFailures?: number;
  /** `false` ⇒ `insertCapturing` resolves `undefined`: the reinsert lost the unique index. */
  readonly reinsertWins?: boolean;
}

/**
 * The five-mock arrangement every reap test needs: a live, occupied meeting holding ONE
 * capturing row that is stale (`createdAt` well past `STUCK_CAPTURE_THRESHOLD_MS`) and
 * unacknowledged (`dailyRecordingId === null`).
 *
 * ⚠ EXTRACTED FOR THE DUPLICATION GATE, NOT FOR TIDINESS. Repeated verbatim across the reap
 * tests it measured ~2.9% of this PR's new code against SonarCloud's ≥3% new-code duplication
 * gate — jscpd at Sonar-like thresholds reported two clone pairs of 110 and 112 tokens.
 */
function arrangeStuckCapture(overrides: StuckCaptureArrangement = {}): void {
  const { reapWins = true, dailyFailures = 0, reinsertWins = true } = overrides;
  findById.mockResolvedValue(liveMeeting());
  listOpen.mockResolvedValue([{ id: 'p1' }]);
  findCapturingForMeeting.mockResolvedValue({
    id: STUCK_ID,
    dailyRecordingId: null,
    createdAt: new Date(Date.now() - 10 * 60_000),
  });
  markFailed.mockResolvedValue(reapWins ? { id: STUCK_ID, status: 'failed' } : undefined);
  countFailedByStage.mockResolvedValue(dailyFailures);
  insertCapturing.mockResolvedValue(reinsertWins ? ROW : undefined);
  startRoomRecording.mockResolvedValue(undefined);
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
   * returning) must stay a routine `log.info`, not an error, and must NOT be reaped. Only
   * STALE rows in this shape are the residual F8/BAL-480 makes observable.
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
    expect(markFailed).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ BAL-480 — THE REAP, END TO END IN ONE INVOCATION. A worker died between
   * `insertCapturing` and the Daily call; the row is stale, `dailyRecordingId` is still
   * `null`, and no Daily event will ever advance it. `handleEnsure` must REAP it (`markFailed`
   * at stage `daily`, releasing the slot) and FALL THROUGH — in the SAME invocation — to
   * insert a fresh segment and call Daily again. This replaces the old FIX ROUND 1 behaviour
   * (log-and-return), which is exactly what this ticket removes.
   */
  it('⚠⚠ a STALE capturing row with no dailyRecordingId is REAPED and falls through to a fresh insert', async () => {
    arrangeStuckCapture();

    await runEnsure({ meetingId: MEETING_ID, trigger: 'sweep' });

    expect(markFailed).toHaveBeenCalledWith({
      id: STUCK_ID,
      stage: 'daily',
      reason: expect.stringContaining('stuck'),
      at: expect.any(Date),
      // ⚠⚠ FIX ROUND 1 — the TOCTOU term. Without it the reap overwrites a late
      // `recording.started` and step 6 double-starts Daily. See the next test for the effect.
      onlyIfUnacknowledged: true,
    });
    expect(countFailedByStage).toHaveBeenCalledWith(MEETING_ID, 'daily');
    expect(insertCapturing).toHaveBeenCalled();
    expect(startRoomRecording).toHaveBeenCalledWith(ROOM, { instanceId: ROW.id });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, recordingId: STUCK_ID }),
      expect.stringContaining('REAPED')
    );
  });

  /**
   * ⚠⚠ FIX ROUND 1 — THE TOCTOU, AND WHY IT IS A BILLING BUG. `stuck` is decided from the row
   * read at step 5; `markStarted` does NOT move `status`, so a `recording.started` committing
   * inside that window is invisible to the base CAS. `onlyIfUnacknowledged` makes the reap LOSE
   * to it (`markFailed` ⇒ `undefined`), the slot stays held, and the fall-through insert loses
   * the partial unique index — so NO second Daily recording starts in the same room. Without
   * the term, `markFailed` would win, the slot would be released, and `startRoomRecording`
   * would fire against a room Daily is already recording: two concurrent captures, both
   * billing.
   */
  it('⚠⚠ a LATE recording.started makes the reap lose — and no second Daily recording starts', async () => {
    arrangeStuckCapture({ reapWins: false, reinsertWins: false });

    await runEnsure({ meetingId: MEETING_ID, trigger: 'sweep' });

    expect(startRoomRecording).not.toHaveBeenCalled();
    expect(trackServer).not.toHaveBeenCalledWith('recording_failed', expect.anything());
    expect(logInfo).toHaveBeenCalledWith(
      { meetingId: MEETING_ID },
      expect.stringContaining('lost the capturing-slot race')
    );
  });

  it('the reap reason string embeds the exported threshold', async () => {
    arrangeStuckCapture();

    await runEnsure({ meetingId: MEETING_ID, trigger: 'sweep' });

    const [call] = markFailed.mock.calls as Array<[{ reason: string }]>;
    expect(call?.[0].reason).toContain(String(STUCK_CAPTURE_THRESHOLD_MS));
  });

  /**
   * ⚠ ANALYTICS GATED ON THE CAS. `markFailed` refuses `failed → failed`, so a concurrent
   * ensure that reaped the slot first makes THIS call's `markFailed` resolve `undefined`. The
   * slot is free either way, so the fall-through still proceeds to a fresh insert — but
   * emitting `RECORDING_FAILED` here would double-count one reap.
   */
  it('⚠ analytics gated on the CAS — a lost reap race still falls through with no double-count', async () => {
    arrangeStuckCapture({ reapWins: false });

    await runEnsure({ meetingId: MEETING_ID, trigger: 'sweep' });

    expect(trackServer).not.toHaveBeenCalledWith('recording_failed', expect.anything());
    expect(insertCapturing).toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, recordingId: STUCK_ID }),
      expect.stringContaining('concurrent')
    );
  });

  it('the reap analytics payload names stage "daily" and reason "stuck_capture"', async () => {
    arrangeStuckCapture();

    await runEnsure({ meetingId: MEETING_ID, trigger: 'sweep' });

    expect(trackServer).toHaveBeenCalledWith('recording_failed', {
      meeting_id: MEETING_ID,
      stage: 'daily',
      reason: 'stuck_capture',
      distinct_id: MEETING_ID,
    });
  });

  /**
   * ⚠⚠ THE CAP STILL REFUSES AFTER A REAP. The reap's own `failed` row is written BEFORE
   * `countFailedByStage` reads (step 5.5 runs after step 5), so it is counted in the SAME
   * invocation — that is what bounds the reap+re-arm loop.
   */
  it('⚠⚠ the cap still refuses after a reap — the slot is freed but no fresh capture starts', async () => {
    arrangeStuckCapture({ dailyFailures: MAX_DAILY_FAILURES_PER_MEETING });

    await runEnsure({ meetingId: MEETING_ID, trigger: 'sweep' });

    expect(markFailed).toHaveBeenCalled();
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
   * ⚠ A stale row that already HAS a `dailyRecordingId` is genuinely capturing (Daily is mid
   * -segment) — age alone must never trip the reap path.
   */
  it('a stale-but-otherwise-normal capturing row (has a dailyRecordingId) still logs at info', async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue({
      id: 'rec-normal',
      dailyRecordingId: 'daily-rec-1',
      createdAt: new Date(Date.now() - 10 * 60_000),
    });
    await runEnsure({ meetingId: MEETING_ID, trigger: 'in_progress' });
    expect(logError).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, recordingId: 'rec-normal' }),
      expect.stringContaining('already_capturing')
    );
    expect(markFailed).not.toHaveBeenCalled();
  });

  /**
   * ⚠ WHAT THIS PINS — AND WHAT IT DOES **NOT** (fix round 1). It pins the ARITHMETIC: the
   * threshold is `minIdleTimeOut + Daily's worst shutdown lag + one sweep tick`, so a future
   * edit that pastes a number instead of deriving it fails here.
   *
   * ⚠⚠ IT IS NOT A TRIPWIRE ON `MIN_IDLE_TIMEOUT_SECONDS`. This file mocks
   * `../services/daily/recordings.js` with a HARDCODED `MIN_IDLE_TIMEOUT_SECONDS: 60`, so both
   * sides of the comparison move together and lowering the REAL constant would not fail this
   * test. The real tripwire is `services/daily/recordings.test.ts`'s
   * `expect(MIN_IDLE_TIMEOUT_SECONDS).toBe(60)`, which asserts the un-mocked value — change
   * that one and this derivation must be revisited by hand.
   */
  it('⚠ the stuck-capture threshold is DERIVED (mocked minIdleTimeOut + shutdown lag + a tick)', () => {
    expect(STUCK_CAPTURE_THRESHOLD_MS).toBe(60 * 1000 + 3 * 60_000 + 60_000);
  });

  /**
   * ⚠⚠ FIX ROUND 1 — THE VENDOR-RATE PACER. `concurrency: 5` bounds jobs IN FLIGHT, not their
   * RATE (≈25 Daily starts/s against a ~1/s tier), and overrunning that tier is destructive
   * rather than slow: §5.1b stamps a `failed` row on every 429 attempt, so a rate-limit storm
   * burns `MAX_DAILY_FAILURES_PER_MEETING` and permanently disables recording — post-outage
   * recovery, the exact scenario this feature ships for. Removing the limiter re-opens that.
   */
  it('⚠⚠ the worker paces Daily starts at 1/s — concurrency alone never bounded the RATE', () => {
    expect(WorkerMock).toHaveBeenCalledWith(
      RECORDING_CAPTURE_QUEUE,
      expect.any(Function),
      expect.objectContaining({ concurrency: 5, limiter: { max: 1, duration: 1000 } })
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

  /**
   * ⚠ BAL-480 — THE CAP'S NEW DERIVATION. Pins that reaps got their OWN allowance rather than
   * sharing the pre-existing re-arm one (`ATTEMPTS + 2`), so the worst case is
   * `ATTEMPTS + 2 (re-arms) + 2 (reaps) = 7`, not `5`.
   */
  it('⚠ the cap is now ATTEMPTS + re-arm allowance + reap allowance, not just ATTEMPTS + 2', () => {
    expect(MAX_DAILY_FAILURES_PER_MEETING).toBeGreaterThan(ATTEMPTS + 2);
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

  /**
   * ⚠ BAL-480 — `trigger: 'sweep'` (the level-triggered lifecycle sweep self-heal) reaches
   * `RECORDING_STARTED` on the clean path exactly like any other trigger, so PostHog can split
   * self-heal attempts from webhook-origin ones.
   */
  it("BAL-480 — trigger: 'sweep' reaches RECORDING_STARTED", async () => {
    findById.mockResolvedValue(liveMeeting());
    listOpen.mockResolvedValue([{ id: 'p1' }]);
    findCapturingForMeeting.mockResolvedValue(undefined);
    insertCapturing.mockResolvedValue(ROW);
    startRoomRecording.mockResolvedValue(undefined);

    await runEnsure({ meetingId: MEETING_ID, trigger: 'sweep' });

    expect(trackServer).toHaveBeenCalledWith(
      'recording_started',
      expect.objectContaining({ trigger: 'sweep' })
    );
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
