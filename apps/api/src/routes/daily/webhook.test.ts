import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindByEventId,
  mockInsertReceived,
  mockMarkProcessed,
  mockFindByRoomName,
  mockCloseAllOpen,
  mockTransaction,
  mockResolvePresenceEffect,
  mockApplyPresenceEffect,
  mockReconcileStatus,
  mockCheckRateLimit,
  mockWarn,
  mockInfoLog,
  mockErrorLog,
  mockFindMeetingById,
  mockFindRecordingById,
  mockFindByDailyRecordingId,
  mockFindCapturingForMeeting,
  mockMarkStarted,
  mockMarkSourceReady,
  mockMarkRecordingFailed,
  mockEnqueueRecordingEnsure,
  mockEnqueueRecordingIngest,
  mockTrackServer,
  mockFindByTranscriptJobId,
  mockMarkTranscriptJobFinished,
  mockMarkTranscriptJobFailed,
  mockEnqueueTranscriptSubmit,
  mockEnqueueTranscriptIngest,
  mockEnqueueRecordingCleanupSource,
} = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockFindByEventId: vi.fn(),
  mockInsertReceived: vi.fn(),
  mockMarkProcessed: vi.fn(),
  mockFindByRoomName: vi.fn(),
  mockCloseAllOpen: vi.fn(),
  mockTransaction: vi.fn(),
  mockResolvePresenceEffect: vi.fn(),
  mockApplyPresenceEffect: vi.fn(),
  mockReconcileStatus: vi.fn(),
  mockWarn: vi.fn(),
  mockInfoLog: vi.fn(),
  mockErrorLog: vi.fn(),
  mockFindMeetingById: vi.fn(),
  mockFindRecordingById: vi.fn(),
  mockFindByDailyRecordingId: vi.fn(),
  mockFindCapturingForMeeting: vi.fn(),
  mockMarkStarted: vi.fn(),
  mockMarkSourceReady: vi.fn(),
  mockMarkRecordingFailed: vi.fn(),
  mockEnqueueRecordingEnsure: vi.fn(),
  mockEnqueueRecordingIngest: vi.fn(),
  mockTrackServer: vi.fn(),
  mockFindByTranscriptJobId: vi.fn(),
  mockMarkTranscriptJobFinished: vi.fn(),
  mockMarkTranscriptJobFailed: vi.fn(),
  mockEnqueueTranscriptSubmit: vi.fn(),
  mockEnqueueTranscriptIngest: vi.fn(),
  mockEnqueueRecordingCleanupSource: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    // ⚠ BAL-480 fix round 1 — `info` is ASSERTED ON now: the room fallback logs every
    // delivery it resolves with no start instant, which is the only way ops can tell whether
    // the start-instant guard is armed in production at all.
    info: mockInfoLog,
    warn: mockWarn,
    error: mockErrorLog,
  }),
}));
vi.mock('@balo/db', () => ({
  db: { transaction: mockTransaction },
  dailyWebhookEventsRepository: {
    findByEventId: mockFindByEventId,
    insertReceived: mockInsertReceived,
    markProcessed: mockMarkProcessed,
  },
  meetingsRepository: { findByDailyRoomName: mockFindByRoomName, findById: mockFindMeetingById },
  meetingPresenceRepository: { closeAllOpen: mockCloseAllOpen },
  meetingRecordingsRepository: {
    findById: mockFindRecordingById,
    findByDailyRecordingId: mockFindByDailyRecordingId,
    findCapturingForMeeting: mockFindCapturingForMeeting,
    markStarted: mockMarkStarted,
    markSourceReady: mockMarkSourceReady,
    markFailed: mockMarkRecordingFailed,
    findByTranscriptJobId: mockFindByTranscriptJobId,
    markTranscriptJobFinished: mockMarkTranscriptJobFinished,
    markTranscriptJobFailed: mockMarkTranscriptJobFailed,
  },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  RECORDING_SERVER_EVENTS: {
    RECORDING_STARTED: 'recording_started',
    RECORDING_READY: 'recording_ready',
    RECORDING_FAILED: 'recording_failed',
  },
  TRANSCRIPT_SERVER_EVENTS: {
    TRANSCRIPT_CAPTURE_SUBMITTED: 'transcript_capture_submitted',
    TRANSCRIPT_CAPTURE_SKIPPED: 'transcript_capture_skipped',
    TRANSCRIPT_CAPTURE_FAILED: 'transcript_capture_failed',
  },
}));
vi.mock('../../services/meetings/presence-writer.js', () => ({
  resolvePresenceEffect: mockResolvePresenceEffect,
  applyPresenceEffect: mockApplyPresenceEffect,
  reconcileMeetingStatus: mockReconcileStatus,
}));
// BAL-473 — MANDATORY: `webhook.ts` now imports these two job modules, which transitively pull
// in BullMQ + `../lib/queue.js` + `../lib/redis.js`. Left unmocked, any test that reaches an
// enqueue would attempt a REAL Redis connection.
vi.mock('../../jobs/recording-capture.js', () => ({
  enqueueRecordingEnsure: mockEnqueueRecordingEnsure,
}));
vi.mock('../../jobs/recording-ingest.js', () => ({
  enqueueRecordingIngest: mockEnqueueRecordingIngest,
}));
// BAL-483 — MANDATORY: `webhook.ts` now imports these two job modules too.
vi.mock('../../jobs/transcript-capture.js', () => ({
  enqueueTranscriptSubmit: mockEnqueueTranscriptSubmit,
  enqueueTranscriptIngest: mockEnqueueTranscriptIngest,
}));
// ⚠⚠ FIX ROUND 2 — `webhook.ts` no longer imports `RECORDING_CLEANUP_SOURCE_QUEUE` or
// `recordingCleanupSourceJobId` (the `Queue.remove()` re-drive recipe that needed them is gone —
// see the docblock at the §7.4 re-drive call site), and no longer imports `../../lib/queue.js`
// at all — so neither is mocked here any more.
vi.mock('../../jobs/recording-cleanup-source.js', () => ({
  enqueueRecordingCleanupSource: mockEnqueueRecordingCleanupSource,
}));
// ⚠ SPREADS THE REAL MODULE — a bare factory would drop `RATE_LIMIT_DEADLINE_MS`, which this
// route imports, and a vitest factory mock throws on any omitted export the graph touches.
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));
// ⚠ `services/daily/webhook-signature.js` and `webhook-events.js` are DELIBERATELY NOT MOCKED.
// The REAL verifier is what the 400 rows below mean — stubbing it would assert that the route
// calls a function, not that an unsigned body is refused — and the REAL Zod boundary is what
// makes the unknown-type row meaningful.

import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import rawBody from 'fastify-raw-body';
import { signDailyWebhookForTest } from '../../services/daily/webhook-signature.js';
import { dailyWebhookRoutes } from './webhook.js';

const SECRET = Buffer.from('a-32-byte-daily-webhook-secret!!').toString('base64');
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const ROOM = 'balo-22222222222242228222222222222222';
const URL = '/webhooks/daily';

const MEETING = {
  id: MEETING_ID,
  status: 'scheduled',
  scheduledStart: new Date('2026-08-14T10:00:00.000Z'),
  scheduledEnd: new Date('2026-08-14T11:00:00.000Z'),
  dailyRoomName: ROOM,
};

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_1',
    type: 'participant.joined',
    event_ts: Math.floor(new Date('2026-08-14T10:01:00.000Z').getTime() / 1000),
    payload: { room: ROOM, user_id: `u${'a'.repeat(32)}` },
    ...overrides,
  });
}

function signedHeaders(payload: string): Record<string, string> {
  return {
    ...signDailyWebhookForTest(Buffer.from(payload), SECRET, new Date()),
    'content-type': 'application/json',
  };
}

describe('POST /webhooks/daily (BAL-134 §5.1)', () => {
  let app: FastifyInstance;
  const originalSecret = process.env.DAILY_WEBHOOK_SECRET;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    // ⚠ THE PRODUCTION ERROR HANDLER, RESTATED — a bare Fastify instance echoes `error.message`
    // into the body, which would assert a leak production does not have.
    app.setErrorHandler((_error, _request, reply) => {
      reply.status(500).send({ error: 'Internal Server Error' });
    });
    // ⚠ THE SAME SCOPED RAW-BODY REGISTRATION THE PLUGIN USES. Without it `request.rawBody` is
    // undefined and every row below would pass for the wrong reason.
    await app.register(rawBody, {
      field: 'rawBody',
      global: false,
      encoding: false,
      runFirst: true,
      routes: [URL],
    });
    await app.register(dailyWebhookRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DAILY_WEBHOOK_SECRET = SECRET;
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 19_999, ttlSeconds: 3600 });
    mockFindByEventId.mockResolvedValue(undefined);
    mockInsertReceived.mockResolvedValue({ id: 'marker-1' });
    mockMarkProcessed.mockResolvedValue(undefined);
    mockFindByRoomName.mockResolvedValue(MEETING);
    mockCloseAllOpen.mockResolvedValue(2);
    mockResolvePresenceEffect.mockResolvedValue({ action: 'open', party: 'client' });
    mockApplyPresenceEffect.mockResolvedValue('opened');
    mockReconcileStatus.mockResolvedValue('waiting_for_participants');
    // Run the callback with a stand-in tx, exactly as `db.transaction` does.
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
    // BAL-473 — recording defaults: no row resolves unless a test says otherwise.
    mockFindMeetingById.mockResolvedValue(MEETING);
    mockFindRecordingById.mockResolvedValue(undefined);
    mockFindByDailyRecordingId.mockResolvedValue(undefined);
    mockFindCapturingForMeeting.mockResolvedValue(undefined);
    mockMarkStarted.mockResolvedValue(undefined);
    mockMarkSourceReady.mockResolvedValue(undefined);
    mockMarkRecordingFailed.mockResolvedValue(undefined);
    mockEnqueueRecordingEnsure.mockResolvedValue(undefined);
    mockEnqueueRecordingIngest.mockResolvedValue(undefined);
    // BAL-483 — batch-processor defaults: no row resolves unless a test says otherwise.
    mockFindByTranscriptJobId.mockResolvedValue(undefined);
    mockMarkTranscriptJobFinished.mockResolvedValue(undefined);
    mockMarkTranscriptJobFailed.mockResolvedValue(undefined);
    mockEnqueueTranscriptSubmit.mockResolvedValue(undefined);
    mockEnqueueTranscriptIngest.mockResolvedValue(undefined);
    mockEnqueueRecordingCleanupSource.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.DAILY_WEBHOOK_SECRET;
    } else {
      process.env.DAILY_WEBHOOK_SECRET = originalSecret;
    }
  });

  async function call(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject(opts);
  }

  // ── CONFIGURATION AND SIGNATURE ─────────────────────────────────────────────────────────

  /**
   * ⚠ A MISSING SECRET IS AN OUTAGE (OURS), NOT A BAD REQUEST. A `400` would tell Daily to stop
   * retrying deliveries that are perfectly valid and that we will process the moment the
   * variable is set.
   */
  it('⚠ 503 when DAILY_WEBHOOK_SECRET is unset — and NOTHING is processed', async () => {
    delete process.env.DAILY_WEBHOOK_SECRET;
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(503);
    expect(mockInsertReceived).not.toHaveBeenCalled();
    expect(mockErrorLog).toHaveBeenCalled();
  });

  it('400 on a bad signature — Daily must not retry a body that will never verify', async () => {
    const payload = body();

    const res = await call({
      method: 'POST',
      url: URL,
      payload,
      headers: { ...signedHeaders(payload), 'x-webhook-signature': 'deadbeef' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid signature' });
    expect(mockInsertReceived).not.toHaveBeenCalled();
  });

  it('400 with NO signature headers at all', async () => {
    const payload = body();

    const res = await call({
      method: 'POST',
      url: URL,
      payload,
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    expect(mockInsertReceived).not.toHaveBeenCalled();
  });

  /** ⚠ THE REASON GOES TO THE LOG AS A FIELD; THE WIRE GETS ONE LITERAL, AND NEVER THE BODY. */
  it('⚠ logs the failure REASON but never the body', async () => {
    const payload = body();

    await call({
      method: 'POST',
      url: URL,
      payload,
      headers: { ...signedHeaders(payload), 'x-webhook-signature': 'deadbeef' },
    });

    expect(mockWarn).toHaveBeenCalledWith(
      { reason: 'bad_signature' },
      'Daily webhook signature verification failed'
    );
    const logged = JSON.stringify(mockWarn.mock.calls);
    expect(logged).not.toContain(ROOM);
  });

  // ── THE THREE HANDLED EVENT TYPES ───────────────────────────────────────────────────────

  it('participant.joined opens an interval and reconciles the status POST-COMMIT', async () => {
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockResolvePresenceEffect).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'open', meeting: MEETING })
    );
    expect(mockApplyPresenceEffect).toHaveBeenCalled();
    expect(mockReconcileStatus).toHaveBeenCalledWith(MEETING, expect.any(Date));
  });

  it('participant.left closes an interval', async () => {
    const payload = body({ type: 'participant.left', id: 'evt_left' });

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockResolvePresenceEffect).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'close' })
    );
  });

  /**
   * ⚠⚠ `meeting.ended` CLOSES EVERY OPEN INTERVAL BUT DOES **NOT** END THE MEETING. A Daily
   * SESSION ends whenever the room empties — including on a four-second network blip that drops
   * everyone — so treating it as a termination would end live consultations. Deciding the
   * meeting is over stays the sweep's, under the idle-end rule.
   */
  it('⚠⚠ meeting.ended closes every open interval and does NOT terminate the meeting', async () => {
    const payload = body({ type: 'meeting.ended', id: 'evt_ended' });

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockCloseAllOpen).toHaveBeenCalledWith(MEETING_ID, expect.any(Date), expect.anything());
    expect(mockReconcileStatus).not.toHaveBeenCalled();
    expect(mockResolvePresenceEffect).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ S5 — THE ONE ARM WITHOUT `applyPresenceEffect`'s CATCH BEHIND IT.
   *
   * `parseDailyWebhookEvent` deliberately returns an INVALID DATE (not `null`) for a
   * present-but-unparseable timestamp, so a body Daily will happily keep sending reaches
   * `closeAllOpen` → `assertFiniteInstant` → THROW. That throw escapes `db.transaction`, ROLLS
   * BACK the `daily_webhook_events` marker and 500s — so Daily retries a permanently-unwritable
   * body forever and eventually DISABLES THE WEBHOOK, silently degrading presence (a money
   * input) to ≤60s sweep reconciliation. The join/leave arms were already safe; this one was not.
   */
  it('⚠⚠ S5 — a `meeting.ended` with an unparseable end_ts acks 200 and commits its marker', async () => {
    const payload = body({
      type: 'meeting.ended',
      id: 'evt_bad_ts',
      event_ts: undefined,
      payload: { room: ROOM, end_ts: 'not-a-timestamp' },
    });

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockCloseAllOpen).not.toHaveBeenCalled();
    // ⚠ THE MARKER STILL COMMITS — the body will never be writable, so a retry is pure noise.
    expect(mockMarkProcessed).toHaveBeenCalledWith('evt_bad_ts', expect.anything());
    expect(mockErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'invalid_timestamp' }),
      expect.stringContaining('non-finite timestamp')
    );
  });

  // ── BAL-473 — THE THREE RECORDING ARMS ──────────────────────────────────────────────────

  const RECORDING_ID = '33333333-3333-4333-8333-333333333333';
  const INSTANCE_ID = RECORDING_ID;
  const RECORDING_CREATED_AT = new Date('2026-08-14T10:00:00.000Z');
  const RECORDING_ROW = {
    id: RECORDING_ID,
    meetingId: MEETING_ID,
    status: 'recording',
    dailyRecordingId: null,
    createdAt: RECORDING_CREATED_AT,
  };

  function recordingBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: 'evt_rec_1',
      type: 'recording.started',
      payload: { instance_id: INSTANCE_ID, recording_id: 'daily-rec-1' },
      ...overrides,
    });
  }

  describe('recording.started', () => {
    it('resolves by instanceId, calls markStarted on the tx — no post-commit action', async () => {
      mockFindRecordingById.mockResolvedValue(RECORDING_ROW);
      mockMarkStarted.mockResolvedValue({ ...RECORDING_ROW, dailyRecordingId: 'daily-rec-1' });
      const payload = recordingBody();

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockFindRecordingById).toHaveBeenCalledWith(INSTANCE_ID);
      expect(mockMarkStarted).toHaveBeenCalledWith(
        expect.objectContaining({ id: RECORDING_ID, dailyRecordingId: 'daily-rec-1' }),
        expect.anything()
      );
      expect(mockEnqueueRecordingIngest).not.toHaveBeenCalled();
      expect(mockEnqueueRecordingEnsure).not.toHaveBeenCalled();
    });

    it('⚠ never inserts a row — an instance id resolving to no row acks with no effect', async () => {
      mockFindRecordingById.mockResolvedValue(undefined);
      const payload = recordingBody();

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMarkStarted).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'recording.started' }),
        expect.stringContaining('no row')
      );
    });

    it('⚠⚠ the T5 residual — a failed row logs at ERROR rather than reviving', async () => {
      mockFindRecordingById.mockResolvedValue({ ...RECORDING_ROW, status: 'failed' });
      mockMarkStarted.mockResolvedValue(undefined);
      const payload = recordingBody();

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockErrorLog).toHaveBeenCalledWith(
        expect.objectContaining({ recordingId: RECORDING_ID }),
        expect.stringContaining('already marked failed')
      );
    });

    it('does NOT call reconcileMeetingStatus for a recording arm', async () => {
      mockFindRecordingById.mockResolvedValue(RECORDING_ROW);
      mockMarkStarted.mockResolvedValue(RECORDING_ROW);
      const payload = recordingBody();

      await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

      expect(mockReconcileStatus).not.toHaveBeenCalled();
    });
  });

  describe('recording.ready-to-download', () => {
    function readyPayload(overrides: Record<string, unknown> = {}): string {
      return recordingBody({
        type: 'recording.ready-to-download',
        id: 'evt_rec_2',
        payload: { recording_id: 'daily-rec-1', room: ROOM, duration: 90 },
        ...overrides,
      });
    }

    it('resolves by recording_id, marks source_ready, enqueues ingest + the re-arm', async () => {
      mockFindByDailyRecordingId.mockResolvedValue(RECORDING_ROW);
      mockMarkSourceReady.mockResolvedValue({ ...RECORDING_ROW, status: 'source_ready' });
      const payload = readyPayload();

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockFindByDailyRecordingId).toHaveBeenCalledWith('daily-rec-1');
      expect(mockMarkSourceReady).toHaveBeenCalledWith(
        expect.objectContaining({ id: RECORDING_ID, dailyRecordingId: 'daily-rec-1' }),
        expect.anything()
      );
      expect(mockEnqueueRecordingIngest).toHaveBeenCalledWith({ recordingId: RECORDING_ID });
      // ⚠⚠ BAL-483 — the transcription producer joins the SAME `recordingTransitioned` gate.
      expect(mockEnqueueTranscriptSubmit).toHaveBeenCalledWith({ recordingId: RECORDING_ID });
      // ⚠⚠ THE UNCONDITIONAL RE-ARM — the job gates itself, so this enqueue is free.
      expect(mockEnqueueRecordingEnsure).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: MEETING_ID, trigger: 'rejoin' })
      );
    });

    it('⚠ the FALLBACK ladder: a miss on recording_id resolves via room → capturing', async () => {
      mockFindByDailyRecordingId.mockResolvedValue(undefined);
      mockFindCapturingForMeeting.mockResolvedValue(RECORDING_ROW); // dailyRecordingId: null
      mockMarkSourceReady.mockResolvedValue({ ...RECORDING_ROW, status: 'source_ready' });
      const payload = readyPayload();

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockFindByRoomName).toHaveBeenCalledWith(ROOM);
      expect(mockFindCapturingForMeeting).toHaveBeenCalledWith(MEETING_ID);
      expect(mockMarkSourceReady).toHaveBeenCalled();
    });

    it('⚠⚠ REFUSES the fallback when the capturing row already has a DIFFERENT dailyRecordingId', async () => {
      mockFindByDailyRecordingId.mockResolvedValue(undefined);
      mockFindCapturingForMeeting.mockResolvedValue({
        ...RECORDING_ROW,
        dailyRecordingId: 'some-other-daily-id',
      });
      const payload = readyPayload();

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMarkSourceReady).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'recording.ready-to-download' }),
        expect.stringContaining('no row')
      );
    });

    // ── BAL-480 — THE START-INSTANT GUARD ON THE ROOM FALLBACK ───────────────────────────

    /**
     * ⚠⚠ THE ORPHAN IS REFUSED. This `ready-to-download` names a recording that began FIVE
     * MINUTES BEFORE the meeting's current capturing segment was even created — exactly the
     * shape a stuck-slot reap's orphaned earlier Daily recording produces. Accepting it would
     * mark the LIVE segment `source_ready` against the orphan's asset and release its slot
     * mid-capture.
     */
    it('⚠⚠ BAL-480 — the orphan is refused: a start instant BEFORE the capturing row is created', async () => {
      mockFindByDailyRecordingId.mockResolvedValue(undefined);
      mockFindCapturingForMeeting.mockResolvedValue({
        ...RECORDING_ROW,
        dailyRecordingId: null,
        createdAt: RECORDING_CREATED_AT,
      });
      const startTs = (RECORDING_CREATED_AT.getTime() - 5 * 60_000) / 1000;
      const payload = readyPayload({
        payload: { recording_id: 'daily-rec-1', room: ROOM, start_ts: startTs },
      });

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMarkSourceReady).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ roomName: ROOM }),
        expect.stringContaining('began BEFORE')
      );
      expect(mockEnqueueRecordingIngest).not.toHaveBeenCalled();
    });

    it('BAL-480 — the legitimate backfill still resolves (start instant just after createdAt)', async () => {
      mockFindByDailyRecordingId.mockResolvedValue(undefined);
      mockFindCapturingForMeeting.mockResolvedValue({
        ...RECORDING_ROW,
        dailyRecordingId: null,
        createdAt: RECORDING_CREATED_AT,
      });
      mockMarkSourceReady.mockResolvedValue({ ...RECORDING_ROW, status: 'source_ready' });
      const startTs = (RECORDING_CREATED_AT.getTime() + 1_000) / 1000;
      const payload = readyPayload({
        payload: { recording_id: 'daily-rec-1', room: ROOM, start_ts: startTs },
      });

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMarkSourceReady).toHaveBeenCalledWith(
        expect.objectContaining({ dailyRecordingId: 'daily-rec-1' }),
        expect.anything()
      );
    });

    it('BAL-480 — a start instant inside the clock-skew tolerance still resolves', async () => {
      mockFindByDailyRecordingId.mockResolvedValue(undefined);
      mockFindCapturingForMeeting.mockResolvedValue({
        ...RECORDING_ROW,
        dailyRecordingId: null,
        createdAt: RECORDING_CREATED_AT,
      });
      mockMarkSourceReady.mockResolvedValue({ ...RECORDING_ROW, status: 'source_ready' });
      const startTs = (RECORDING_CREATED_AT.getTime() - 30_000) / 1000;
      const payload = readyPayload({
        payload: { recording_id: 'daily-rec-1', room: ROOM, start_ts: startTs },
      });

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMarkSourceReady).toHaveBeenCalled();
    });

    /**
     * ⚠⚠ BAL-480 FIX ROUND 1 — THE GUARD REFUSES AN UNINTERPRETABLE START INSTANT RATHER THAN
     * FAILING OPEN. `instantFrom` returns an INVALID DATE (not `null`) for a present-but
     * -unparseable value, and `NaN < x` is `false` — so a bare comparison would have let
     * `start_ts: "garbage"` through and taken the pre-BAL-480 path, on precisely the input where
     * we can least prove the payload belongs to the current segment.
     */
    it('⚠⚠ BAL-480 — an UNPARSEABLE start_ts is REFUSED, not silently accepted', async () => {
      mockFindByDailyRecordingId.mockResolvedValue(undefined);
      mockFindCapturingForMeeting.mockResolvedValue({
        ...RECORDING_ROW,
        dailyRecordingId: null,
        createdAt: RECORDING_CREATED_AT,
      });
      const payload = readyPayload({
        payload: { recording_id: 'daily-rec-1', room: ROOM, start_ts: 'not-a-timestamp' },
      });

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMarkSourceReady).not.toHaveBeenCalled();
      expect(mockEnqueueRecordingIngest).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ roomName: ROOM, eventKind: 'recording.ready-to-download' }),
        expect.stringContaining('UNINTERPRETABLE')
      );
    });

    /**
     * ⚠⚠ BAL-480 FIX ROUND 1 — THE OBSERVABILITY HALF. The parser reads `start_ts` (either
     * spelling) and this module could not verify that field name against docs.daily.co. If
     * Daily's real payload omits or renames it, `startedAt` is permanently `null`, the guard
     * NEVER ARMS, and without this log line nothing would say so. A guard nobody can prove is
     * running is not a guard.
     */
    it('⚠⚠ BAL-480 — an ABSENT start_ts still resolves, and LOGS that the guard was unarmed', async () => {
      mockFindByDailyRecordingId.mockResolvedValue(undefined);
      mockFindCapturingForMeeting.mockResolvedValue({
        ...RECORDING_ROW,
        dailyRecordingId: null,
        createdAt: RECORDING_CREATED_AT,
      });
      mockMarkSourceReady.mockResolvedValue({ ...RECORDING_ROW, status: 'source_ready' });
      const payload = readyPayload({
        payload: { recording_id: 'daily-rec-1', room: ROOM },
      });

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMarkSourceReady).toHaveBeenCalled();
      expect(mockInfoLog).toHaveBeenCalledWith(
        expect.objectContaining({
          roomName: ROOM,
          recordingId: RECORDING_ID,
          eventKind: 'recording.ready-to-download',
        }),
        expect.stringContaining('NO start instant')
      );
    });

    /**
     * ⚠ BAL-480 FIX ROUND 1 — `startTs` IS ACCEPTED TOO, end to end through the route. Every
     * other field in `webhook-events.ts` takes both spellings; `start_ts` was the one exception,
     * and it is the guard's whole discriminator.
     */
    it('BAL-480 — the camelCase `startTs` spelling arms the guard exactly like `start_ts`', async () => {
      mockFindByDailyRecordingId.mockResolvedValue(undefined);
      mockFindCapturingForMeeting.mockResolvedValue({
        ...RECORDING_ROW,
        dailyRecordingId: null,
        createdAt: RECORDING_CREATED_AT,
      });
      const startTs = (RECORDING_CREATED_AT.getTime() - 5 * 60_000) / 1000;
      const payload = readyPayload({
        payload: { recording_id: 'daily-rec-1', room: ROOM, startTs },
      });

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMarkSourceReady).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ roomName: ROOM }),
        expect.stringContaining('began BEFORE')
      );
    });

    it('no ingest enqueue when the CAS was a no-op (replay) — but the unconditional re-arm still fires', async () => {
      mockFindByDailyRecordingId.mockResolvedValue(RECORDING_ROW);
      mockMarkSourceReady.mockResolvedValue(undefined);
      const payload = readyPayload();

      await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

      expect(mockEnqueueRecordingIngest).not.toHaveBeenCalled();
      expect(mockEnqueueTranscriptSubmit).not.toHaveBeenCalled();
      // The unconditional re-arm still fires — it is unconditional BY DESIGN.
      expect(mockEnqueueRecordingEnsure).toHaveBeenCalled();
    });

    /**
     * ⚠⚠ FIX ROUND 1 (F1) — a bare `await enqueueRecordingIngest(...)` would let this rejection
     * escape the handler, 500 the delivery, and Daily's retry would short-circuit on
     * `processedAt` with NO enqueue and NO transaction — the row wedged at `source_ready`
     * forever, with no sweep and no ops signal. `enqueueBestEffort` must swallow it and the
     * delivery must still ack `200`.
     */
    it('⚠⚠ a failed recording-ingest enqueue does NOT 500 the delivery — best-effort, logged', async () => {
      mockFindByDailyRecordingId.mockResolvedValue(RECORDING_ROW);
      mockMarkSourceReady.mockResolvedValue({ ...RECORDING_ROW, status: 'source_ready' });
      mockEnqueueRecordingIngest.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const payload = readyPayload();

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockErrorLog).toHaveBeenCalledWith(
        expect.objectContaining({ recordingId: RECORDING_ID, error: 'ECONNREFUSED' }),
        expect.stringContaining('recording-ingest enqueue failed')
      );
      // The unrelated re-arm enqueue still runs — one failed best-effort call must not block another.
      expect(mockEnqueueRecordingEnsure).toHaveBeenCalled();
    });
  });

  describe('recording.error', () => {
    function errorPayload(overrides: Record<string, unknown> = {}): string {
      return recordingBody({
        type: 'recording.error',
        id: 'evt_rec_3',
        payload: { instance_id: INSTANCE_ID, room: ROOM, error_msg: 'disk full' },
        ...overrides,
      });
    }

    it('resolves by instance id, marks failed, emits recording_failed + the re-arm', async () => {
      mockFindRecordingById.mockResolvedValue(RECORDING_ROW);
      mockMarkRecordingFailed.mockResolvedValue({ ...RECORDING_ROW, status: 'failed' });
      const payload = errorPayload();

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMarkRecordingFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: RECORDING_ID, stage: 'daily', reason: 'disk full' }),
        expect.anything()
      );
      expect(mockTrackServer).toHaveBeenCalledWith('recording_failed', {
        meeting_id: MEETING_ID,
        stage: 'daily',
        reason: 'vendor_reported',
        distinct_id: MEETING_ID,
      });
      expect(mockEnqueueRecordingEnsure).toHaveBeenCalledWith(
        expect.objectContaining({ meetingId: MEETING_ID, trigger: 'rejoin' })
      );
    });

    it('⚠ falls back via room → capturing when instance_id is absent', async () => {
      mockFindCapturingForMeeting.mockResolvedValue(RECORDING_ROW);
      mockMarkRecordingFailed.mockResolvedValue({ ...RECORDING_ROW, status: 'failed' });
      const payload = errorPayload({ payload: { room: ROOM, error_msg: 'timeout' } });

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockFindByRoomName).toHaveBeenCalledWith(ROOM);
      expect(mockMarkRecordingFailed).toHaveBeenCalled();
    });

    it('⚠ refuses to overwrite a `ready` row — no analytics on a refused CAS', async () => {
      mockFindRecordingById.mockResolvedValue({ ...RECORDING_ROW, status: 'ready' });
      mockMarkRecordingFailed.mockResolvedValue(undefined);
      const payload = errorPayload();

      await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

      expect(mockTrackServer).not.toHaveBeenCalled();
      // The re-arm still fires — unconditional by design.
      expect(mockEnqueueRecordingEnsure).toHaveBeenCalled();
    });

    it('⚠⚠ FIX ROUND 1 (M3, in passing) — a signed-URL-bearing vendor error is SANITIZED before it is persisted here too', async () => {
      mockFindRecordingById.mockResolvedValue(RECORDING_ROW);
      mockMarkRecordingFailed.mockResolvedValue({ ...RECORDING_ROW, status: 'failed' });
      const leakyErrorMsg =
        'Failed to download https://s3.amazonaws.com/daily-recordings/abc123?X-Amz-Signature=SECRET: 403 Forbidden';
      const payload = errorPayload({
        payload: { instance_id: INSTANCE_ID, room: ROOM, error_msg: leakyErrorMsg },
      });

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      const [writeInput] = mockMarkRecordingFailed.mock.calls[0] as [{ reason: string }];
      expect(writeInput.reason).not.toContain('X-Amz-Signature=SECRET');
      expect(writeInput.reason).toContain('[redacted-url]');
    });
  });

  // ── BAL-483 — THE TWO BATCH-PROCESSOR ARMS ──────────────────────────────────────────────

  describe('batch-processor.job-finished / .error', () => {
    const BATCH_JOB_ID = '02c2508e-8835-4f3e-bcf2-e319d00f0eec';

    function batchRecordingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: RECORDING_ID,
        meetingId: MEETING_ID,
        status: 'source_ready',
        dailyRecordingId: 'daily-rec-1',
        transcriptJobId: BATCH_JOB_ID,
        ...overrides,
      };
    }

    function batchPayload(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        id: 'evt_batch_1',
        type: 'batch-processor.job-finished',
        payload: {
          id: BATCH_JOB_ID,
          preset: 'transcript',
          status: 'finished',
          input: {},
          output: {},
        },
        ...overrides,
      });
    }

    it('job-finished resolved by transcript_job_id → markTranscriptJobFinished inside the txn, then enqueueTranscriptIngest post-commit', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(batchRecordingRow());
      mockMarkTranscriptJobFinished.mockResolvedValue(batchRecordingRow());
      const payload = batchPayload();

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockFindByTranscriptJobId).toHaveBeenCalledWith(BATCH_JOB_ID);
      // ⚠⚠ TIGHTENED (fix round 1) — `expect.anything()` catches OMISSION of the executor but
      // not `db` being passed instead of `tx`; assert the ACTUAL transaction object, the same
      // one `insertReceived` got in this same request (the "stamps processed_at on the SAME
      // executor" pattern already used elsewhere in this file, at `:1234-1242` today).
      const [, insertExec] = mockInsertReceived.mock.calls[0] as [unknown, unknown];
      expect(mockMarkTranscriptJobFinished).toHaveBeenCalledWith(
        expect.objectContaining({ id: RECORDING_ID }),
        insertExec
      );
      expect(insertExec).not.toBe(undefined);
      expect(mockEnqueueTranscriptIngest).toHaveBeenCalledWith({
        recordingId: RECORDING_ID,
        batchJobId: BATCH_JOB_ID,
      });
    });

    it('resolved by the input.recordingId FALLBACK when no row carries the job id', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(undefined);
      mockFindByDailyRecordingId.mockResolvedValue(batchRecordingRow({ transcriptJobId: null }));
      mockMarkTranscriptJobFinished.mockResolvedValue(batchRecordingRow());
      const payload = batchPayload({
        payload: { id: BATCH_JOB_ID, input: { recordingId: 'daily-rec-1' } },
      });

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockFindByDailyRecordingId).toHaveBeenCalledWith('daily-rec-1');
      expect(mockMarkTranscriptJobFinished).toHaveBeenCalled();
    });

    it('⚠⚠ the fallback REFUSES a row whose transcript_job_id names a DIFFERENT job', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(undefined);
      mockFindByDailyRecordingId.mockResolvedValue(
        batchRecordingRow({ transcriptJobId: 'some-other-job-id' })
      );
      const payload = batchPayload({
        payload: { id: BATCH_JOB_ID, input: { recordingId: 'daily-rec-1' } },
      });

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMarkTranscriptJobFinished).not.toHaveBeenCalled();
      // ⚠ BAL-518 (FIX ROUND 3) — `info`, not `warn`. Once a Daily webhook subscription targets
      // `/webhooks/daily` alongside the legacy Bubble one, Bubble's own batch-processor events
      // will ROUTINELY resolve to no row on our side — expected traffic, not an anomaly.
      expect(mockInfoLog).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'batch-processor.job-finished' }),
        expect.stringContaining('no row')
      );
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('unresolvable to any row ⇒ log.info + 200, no effect (BAL-518 — routine Bubble traffic, not warn)', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(undefined);
      const payload = batchPayload();

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockMarkTranscriptJobFinished).not.toHaveBeenCalled();
      expect(mockInfoLog).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'batch-processor.job-finished' }),
        expect.stringContaining('no row')
      );
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('batch-processor.error → markTranscriptJobFailed + TRANSCRIPT_CAPTURE_FAILED with reason vendor_reported — NEVER the vendor text', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(batchRecordingRow());
      mockMarkTranscriptJobFailed.mockResolvedValue(batchRecordingRow());
      const errorText = 'transcript job failed: Error: Failed to download: 403 Forbidden';
      const payload = batchPayload({
        type: 'batch-processor.error',
        payload: { id: BATCH_JOB_ID, error: errorText },
      });

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      // ⚠⚠ TIGHTENED (fix round 1) — the SAME tx `insertReceived` got, not `expect.anything()`
      // (which would also pass if the code passed `db` instead of `tx`).
      const [, insertExec] = mockInsertReceived.mock.calls[0] as [unknown, unknown];
      expect(mockMarkTranscriptJobFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: RECORDING_ID, reason: errorText }),
        insertExec
      );
      expect(mockTrackServer).toHaveBeenCalledWith('transcript_capture_failed', {
        meeting_id: MEETING_ID,
        recording_id: RECORDING_ID,
        stage: 'batch_job',
        reason: 'vendor_reported',
        distinct_id: MEETING_ID,
      });
      // ⚠ the raw vendor text never reaches the analytics call.
      expect(mockTrackServer).not.toHaveBeenCalledWith(
        'transcript_capture_failed',
        expect.objectContaining({ reason: errorText })
      );
    });

    it('⚠⚠ FIX ROUND 1 (M3) — a signed-URL-bearing vendor error is SANITIZED before it is persisted', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(batchRecordingRow());
      mockMarkTranscriptJobFailed.mockResolvedValue(batchRecordingRow());
      const leakyErrorText =
        'transcript job failed: Error: Failed to download: https://s3.amazonaws.com/daily-recordings/abc123?X-Amz-Signature=SECRET: 403 Forbidden';
      const payload = batchPayload({
        type: 'batch-processor.error',
        payload: { id: BATCH_JOB_ID, error: leakyErrorText },
      });

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      const [writeInput] = mockMarkTranscriptJobFailed.mock.calls[0] as [{ reason: string }];
      expect(writeInput.reason).not.toContain('X-Amz-Signature=SECRET');
      expect(writeInput.reason).toContain('[redacted-url]');
    });

    it('⚠⚠ FIX ROUND 1 (M4) — batch-processor.error now logs at error too, with the SANITIZED text, never raw', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(batchRecordingRow());
      mockMarkTranscriptJobFailed.mockResolvedValue(batchRecordingRow());
      const leakyErrorText =
        'transcript job failed: Error: Failed to download: https://s3.amazonaws.com/daily-recordings/abc123?X-Amz-Signature=SECRET: 403 Forbidden';
      const payload = batchPayload({
        type: 'batch-processor.error',
        payload: { id: BATCH_JOB_ID, error: leakyErrorText },
      });

      await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

      expect(mockErrorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          meetingId: MEETING_ID,
          recordingId: RECORDING_ID,
          error: expect.stringContaining('[redacted-url]'),
        }),
        expect.stringContaining('batch-processor')
      );
      const [errorFields] = mockErrorLog.mock.calls[0] as [{ error: string }];
      expect(errorFields.error).not.toContain('X-Amz-Signature=SECRET');
    });

    it('a replayed batch delivery (processedAt set) short-circuits with NO transaction, no second enqueue', async () => {
      mockFindByEventId.mockResolvedValue({ id: 'marker-1', processedAt: new Date() });
      const payload = batchPayload();

      const res = await call({
        method: 'POST',
        url: URL,
        payload,
        headers: signedHeaders(payload),
      });

      expect(res.statusCode).toBe(200);
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockFindByTranscriptJobId).not.toHaveBeenCalled();
    });

    it('⚠⚠ BOTH terminal arms re-enqueue recording-cleanup-source when the row is already ready — the release valve, keyed on the batch job id (fix round 2)', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(batchRecordingRow({ status: 'ready' }));
      mockMarkTranscriptJobFinished.mockResolvedValue(batchRecordingRow({ status: 'ready' }));
      const payload = batchPayload();

      await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

      // ⚠⚠ FIX ROUND 2 — no more remove(): the re-drive carries its OWN, write-keyed jobId
      // (`dedupeToken` = the batch job id) instead of colliding with the Mux-triggered,
      // row-keyed enqueue. See `recordingCleanupSourceJobId` and the docblock at this call site.
      expect(mockEnqueueRecordingCleanupSource).toHaveBeenCalledWith({
        recordingId: RECORDING_ID,
        dedupeToken: BATCH_JOB_ID,
      });
    });

    it('⚠⚠ FIX ROUND 2 — a REPLAYED batch-processor.job-finished delivery re-drives under the SAME dedupeToken (same batch job id ⇒ same jobId), so BullMQ dedups it to ONE re-drive rather than firing a second job', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(batchRecordingRow({ status: 'ready' }));
      mockMarkTranscriptJobFinished.mockResolvedValue(batchRecordingRow({ status: 'ready' }));
      const payload = batchPayload();

      // Two independent deliveries of the IDENTICAL event (a vendor retry that arrives before
      // `markProcessed` commits, or a genuinely re-sent webhook) — neither resolves
      // `processedAt` on the marker lookup here, so both reach the re-drive.
      await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });
      await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

      expect(mockEnqueueRecordingCleanupSource).toHaveBeenCalledTimes(2);
      const [firstArgs] = mockEnqueueRecordingCleanupSource.mock.calls[0] as [
        { dedupeToken?: string },
      ];
      const [secondArgs] = mockEnqueueRecordingCleanupSource.mock.calls[1] as [
        { dedupeToken?: string },
      ];
      // ⚠ recordingCleanupSourceJobId is a PURE function of recordingId + dedupeToken, so an
      // identical dedupeToken across both deliveries is what makes them land on the identical
      // jobId at the BullMQ layer — the replay dedups to one re-drive rather than two.
      expect(firstArgs.dedupeToken).toBe(BATCH_JOB_ID);
      expect(secondArgs.dedupeToken).toBe(BATCH_JOB_ID);
    });

    it('batch-processor.error ALSO re-enqueues recording-cleanup-source when the row is already ready', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(batchRecordingRow({ status: 'ready' }));
      mockMarkTranscriptJobFailed.mockResolvedValue(batchRecordingRow({ status: 'ready' }));
      const payload = batchPayload({
        type: 'batch-processor.error',
        payload: { id: BATCH_JOB_ID, error: 'boom' },
      });

      await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

      expect(mockEnqueueRecordingCleanupSource).toHaveBeenCalledWith({
        recordingId: RECORDING_ID,
        dedupeToken: BATCH_JOB_ID,
      });
    });

    it('does NOT re-enqueue recording-cleanup-source when the row is not yet ready', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(batchRecordingRow({ status: 'source_ready' }));
      mockMarkTranscriptJobFinished.mockResolvedValue(
        batchRecordingRow({ status: 'source_ready' })
      );
      const payload = batchPayload();

      await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

      expect(mockEnqueueRecordingCleanupSource).not.toHaveBeenCalled();
    });

    it('⚠ the cleanup re-enqueue fires even on a CAS no-op — unconditional, like the recording re-arm', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(batchRecordingRow({ status: 'ready' }));
      mockMarkTranscriptJobFinished.mockResolvedValue(undefined);
      const payload = batchPayload();

      await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

      expect(mockEnqueueRecordingCleanupSource).toHaveBeenCalledWith({
        recordingId: RECORDING_ID,
        dedupeToken: BATCH_JOB_ID,
      });
      // ...but no ingest, since the CAS did not actually transition the row.
      expect(mockEnqueueTranscriptIngest).not.toHaveBeenCalled();
    });

    it('⚠⚠ neither batch arm touches the RECORDING state machine (markSourceReady / markFailed / markStarted)', async () => {
      mockFindByTranscriptJobId.mockResolvedValue(batchRecordingRow());
      mockMarkTranscriptJobFinished.mockResolvedValue(batchRecordingRow());
      const payload = batchPayload();

      await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

      expect(mockMarkSourceReady).not.toHaveBeenCalled();
      expect(mockMarkRecordingFailed).not.toHaveBeenCalled();
      expect(mockMarkStarted).not.toHaveBeenCalled();
    });
  });

  it('⚠ a replayed recording delivery (processedAt set) short-circuits with NO transaction', async () => {
    mockFindByEventId.mockResolvedValue({ id: 'marker-1', processedAt: new Date() });
    const payload = recordingBody();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockFindRecordingById).not.toHaveBeenCalled();
  });

  it('⚠ insertReceived returning undefined (concurrent delivery) abandons the recording effect', async () => {
    mockFindRecordingById.mockResolvedValue(RECORDING_ROW);
    mockInsertReceived.mockResolvedValue(undefined);
    const payload = recordingBody();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockMarkStarted).not.toHaveBeenCalled();
    expect(mockMarkProcessed).not.toHaveBeenCalled();
  });

  // ── ACK-AND-FORGET PATHS ────────────────────────────────────────────────────────────────

  /**
   * ⚠ AN UNKNOWN TYPE MUST NEVER 500. Daily fires types Balo does not handle, and a `500` would
   * flood the retry queue and eventually get the WEBHOOK DISABLED — taking the three types we
   * DO care about down with it.
   */
  it('⚠ an UNKNOWN event type records its marker and acks 200 with no effect', async () => {
    const payload = body({ type: 'room.created', id: 'evt_room' });

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockInsertReceived).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt_room', type: 'room.created' }),
      expect.anything()
    );
    expect(mockResolvePresenceEffect).not.toHaveBeenCalled();
    expect(mockMarkProcessed).toHaveBeenCalled();
  });

  it('a room name that is not ours never costs a database lookup', async () => {
    const payload = body({
      payload: { room: 'someone-elses-room', user_id: `u${'a'.repeat(32)}` },
    });

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockFindByRoomName).not.toHaveBeenCalled();
  });

  it('a room with no live meeting acks with a warn and no effect (edge case 21)', async () => {
    mockFindByRoomName.mockResolvedValue(undefined);
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockResolvePresenceEffect).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ roomName: ROOM }),
      expect.stringContaining('no live meeting')
    );
  });

  it('400 on a signed body with no event id — the marker table would have nothing to key on', async () => {
    const payload = JSON.stringify({ type: 'participant.joined', payload: { room: ROOM } });

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_payload' });
  });

  // ── IDEMPOTENCY (D2) ────────────────────────────────────────────────────────────────────

  /**
   * ⚠⚠ THE CASE THE PRESENCE PRIMITIVES ALONE DO **NOT** COVER: a replayed `participant.joined`
   * after the interval legitimately CLOSED. The one-open-per-identity unique index only
   * constrains OPEN intervals, so the replay would insert a SECOND interval anchored in the past
   * with no `left_at` — a silent, unbounded over-bill.
   */
  it('⚠⚠ a fully-processed REPLAY short-circuits with NO transaction and NO second effect', async () => {
    mockFindByEventId.mockResolvedValue({ id: 'marker-1', processedAt: new Date() });
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockApplyPresenceEffect).not.toHaveBeenCalled();
    expect(mockReconcileStatus).not.toHaveBeenCalled();
  });

  /**
   * ⚠ A ROW WITH A **NULL** `processed_at` IS A DELIVERY THAT DIED BEFORE COMMITTING ITS EFFECT.
   * Branching on PRESENCE rather than on the stamp would silently drop the effect of the retry
   * that exists to repair it.
   */
  it('⚠ a marker with a NULL processed_at is NOT a replay — the retry re-applies', async () => {
    mockFindByEventId.mockResolvedValue({ id: 'marker-1', processedAt: null });
    const payload = body();

    await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(mockTransaction).toHaveBeenCalled();
  });

  /**
   * ⚠ THE UNIQUE INDEX IS THE REAL CONCURRENCY GATE, not the pre-transaction read. Two
   * simultaneous deliveries can both pass that read; only the insert serialises them.
   */
  it('⚠ a CONCURRENT delivery that loses the unique index applies NO effect', async () => {
    mockInsertReceived.mockResolvedValue(undefined);
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockApplyPresenceEffect).not.toHaveBeenCalled();
    expect(mockMarkProcessed).not.toHaveBeenCalled();
  });

  it('stamps processed_at on the SAME executor as the effect', async () => {
    const payload = body();

    await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    const [, insertExec] = mockInsertReceived.mock.calls[0] as [unknown, unknown];
    const [, stampExec] = mockMarkProcessed.mock.calls[0] as [unknown, unknown];
    expect(stampExec).toBe(insertExec);
  });

  /**
   * ⚠⚠ PHASE 1 IS READS ONLY, **OUTSIDE** THE TRANSACTION — `presence-writer.ts`'s own contract,
   * in as many words. Resolving a party runs the participation gate plus a delivery-identity
   * read; doing that while holding an open transaction lengthens every webhook's lock window on
   * `meeting_presence` for work that writes nothing.
   */
  it('⚠⚠ resolves the presence effect BEFORE the transaction opens', async () => {
    const order: string[] = [];
    mockResolvePresenceEffect.mockImplementation(async () => {
      order.push('resolve');
      return { action: 'open', party: 'client' };
    });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      order.push('transaction');
      return fn({});
    });
    const payload = body();

    await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(order).toEqual(['resolve', 'transaction']);
  });

  // ── ⚠ THE PER-IP WINDOW ────────────────────────────────────────────────────────────────

  /**
   * ⚠ WHAT IT PROTECTS IS CPU. Signature verification hashes the whole raw body — up to 1 MB —
   * and an attacker needs no secret and no valid signature to make the server do that work, only
   * a fresh timestamp. So the window is consumed BEFORE the HMAC, not after it.
   */
  it('⚠ consumes a PER-IP window BEFORE the signature is verified', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, ttlSeconds: 60 });
    const payload = body();

    const res = await call({
      method: 'POST',
      url: URL,
      payload,
      headers: { ...signedHeaders(payload), 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(503);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ keyPrefix: 'ratelimit:daily-webhook:ip' }),
      expect.any(String)
    );
    expect(mockFindByEventId).not.toHaveBeenCalled();
  });

  /**
   * ⚠ FAILS CLOSED, AND THAT IS SAFE **ONLY BECAUSE DAILY RETRIES**. A `503` keeps the delivery
   * in the vendor's queue, and the marker table makes the retry idempotent.
   */
  it('⚠ 503 when the limiter is unavailable — the delivery is deferred, not processed unmetered', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('redis unreachable'));
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
    expect(mockInsertReceived).not.toHaveBeenCalled();
  });
});
