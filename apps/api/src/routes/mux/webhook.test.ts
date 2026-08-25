import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindByEventId,
  mockInsertReceived,
  mockMarkProcessed,
  mockFindMeetingById,
  mockFindRecordingById,
  mockFindByMuxAssetId,
  mockMarkReady,
  mockMarkFailed,
  mockTransaction,
  mockCheckRateLimit,
  mockEnqueueRecordingCleanupSource,
  mockTrackServer,
  mockWarn,
  mockErrorLog,
} = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockFindByEventId: vi.fn(),
  mockInsertReceived: vi.fn(),
  mockMarkProcessed: vi.fn(),
  mockFindMeetingById: vi.fn(),
  mockFindRecordingById: vi.fn(),
  mockFindByMuxAssetId: vi.fn(),
  mockMarkReady: vi.fn(),
  mockMarkFailed: vi.fn(),
  mockTransaction: vi.fn(),
  mockEnqueueRecordingCleanupSource: vi.fn(),
  mockTrackServer: vi.fn(),
  mockWarn: vi.fn(),
  mockErrorLog: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: mockErrorLog }),
}));
vi.mock('@balo/db', () => ({
  db: { transaction: mockTransaction },
  muxWebhookEventsRepository: {
    findByEventId: mockFindByEventId,
    insertReceived: mockInsertReceived,
    markProcessed: mockMarkProcessed,
  },
  meetingsRepository: { findById: mockFindMeetingById },
  meetingRecordingsRepository: {
    findById: mockFindRecordingById,
    findByMuxAssetId: mockFindByMuxAssetId,
    markReady: mockMarkReady,
    markFailed: mockMarkFailed,
  },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  RECORDING_SERVER_EVENTS: {
    RECORDING_STARTED: 'recording_started',
    RECORDING_READY: 'recording_ready',
    RECORDING_FAILED: 'recording_failed',
  },
}));
vi.mock('../../jobs/recording-cleanup-source.js', () => ({
  enqueueRecordingCleanupSource: mockEnqueueRecordingCleanupSource,
}));
// ⚠ SPREADS THE REAL MODULE — a bare factory would drop `RATE_LIMIT_DEADLINE_MS`.
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));
// ⚠ `services/mux/webhook-signature.js` and `webhook-events.js` are DELIBERATELY NOT MOCKED —
// the REAL verifier is what the 400 rows below mean, and the REAL Zod boundary is what makes
// the unknown-type row meaningful.

import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import rawBody from 'fastify-raw-body';
import { signMuxWebhookForTest } from '../../services/mux/webhook-signature.js';
import { muxWebhookRoutes } from './webhook.js';

// ⚠⚠ FIX ROUND 1 (F9) — CONTAINS `!`, a character outside BOTH the base64 and base64url
// alphabets, DELIBERATELY. Mux's secret is keyed AS-IS (never base64-decoded) — the opposite of
// Daily's. A secret an eager `Buffer.from(secret, 'base64')` decode would mangle is what makes a
// copy-paste of Daily's base64-decoding `secretKey()` helper into this signer produce a WRONG
// key and fail every test, instead of silently passing on a secret that happened to tolerate
// decoding.
const SECRET = 'whsec_test_secret_1!';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const RECORDING_ID = '33333333-3333-4333-8333-333333333333';
const ASSET_ID = 'mux-asset-1';
const URL = '/webhooks/mux';

const MEETING = { id: MEETING_ID, status: 'ended', endedAt: new Date('2026-08-14T11:00:00.000Z') };
const RECORDING_ROW = {
  id: RECORDING_ID,
  meetingId: MEETING_ID,
  status: 'ingesting',
  muxAssetId: ASSET_ID,
};

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_1',
    type: 'video.asset.ready',
    data: {
      passthrough: RECORDING_ID,
      id: ASSET_ID,
      duration: 90,
      playback_ids: [{ id: 'pb_signed', policy: 'signed' }],
    },
    ...overrides,
  });
}

function signedHeaders(payload: string): Record<string, string> {
  return {
    ...signMuxWebhookForTest(Buffer.from(payload), SECRET, new Date()),
    'content-type': 'application/json',
  };
}

describe('POST /webhooks/mux (BAL-473 §8)', () => {
  let app: FastifyInstance;
  const originalSecret = process.env.MUX_WEBHOOK_SECRET;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler((_error, _request, reply) => {
      reply.status(500).send({ error: 'Internal Server Error' });
    });
    await app.register(rawBody, {
      field: 'rawBody',
      global: false,
      encoding: false,
      runFirst: true,
      routes: [URL],
    });
    await app.register(muxWebhookRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MUX_WEBHOOK_SECRET = SECRET;
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 1_999, ttlSeconds: 3600 });
    mockFindByEventId.mockResolvedValue(undefined);
    mockInsertReceived.mockResolvedValue({ id: 'marker-1' });
    mockMarkProcessed.mockResolvedValue(undefined);
    mockFindRecordingById.mockResolvedValue(RECORDING_ROW);
    mockFindByMuxAssetId.mockResolvedValue(undefined);
    mockFindMeetingById.mockResolvedValue(MEETING);
    mockMarkReady.mockResolvedValue({ ...RECORDING_ROW, status: 'ready' });
    mockMarkFailed.mockResolvedValue({ ...RECORDING_ROW, status: 'failed' });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
    mockEnqueueRecordingCleanupSource.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.MUX_WEBHOOK_SECRET;
    } else {
      process.env.MUX_WEBHOOK_SECRET = originalSecret;
    }
  });

  async function call(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject(opts);
  }

  // ── CONFIGURATION AND SIGNATURE ─────────────────────────────────────────────────────────

  it('⚠ 503 when MUX_WEBHOOK_SECRET is unset — and NOTHING is processed', async () => {
    delete process.env.MUX_WEBHOOK_SECRET;
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(503);
    expect(mockInsertReceived).not.toHaveBeenCalled();
    expect(mockErrorLog).toHaveBeenCalled();
  });

  it('400 on a bad signature', async () => {
    const payload = body();

    // ⚠⚠ FIX ROUND 1 (F9-1) — `t=` MUST BE FRESH. A stale `t=1700000000` (Nov 2023) is rejected
    // by the FRESHNESS check before the HMAC is ever reached, so a `bad_signature` and a
    // `stale_timestamp` produce the identical 400 body here — the test could not tell a broken
    // signature check from a broken freshness check, and would still pass if the whole HMAC
    // verification were replaced with `return { ok: true }`. A fresh `t=` with a bogus `v1=`
    // forces the rejection to come from the HMAC compare, which is what this test claims to
    // assert.
    const freshT = Math.floor(Date.now() / 1000);

    const res = await call({
      method: 'POST',
      url: URL,
      payload,
      headers: { ...signedHeaders(payload), 'mux-signature': `t=${freshT},v1=deadbeef` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid signature' });
    expect(mockInsertReceived).not.toHaveBeenCalled();
  });

  it('400 with no mux-signature header at all', async () => {
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

  /**
   * ⚠ `decodeJsonBody`'s non-JSON catch (unit-pinned in `lib/webhook-request.test.ts`) is not
   * separately exercised end-to-end here: with `content-type: application/json`, Fastify's OWN
   * built-in JSON parser fails on genuinely malformed JSON syntax BEFORE this route runs at
   * all — the same reason `routes/daily/webhook.test.ts` (the precedent this suite mirrors)
   * has no such case either. A schema-invalid-but-syntactically-valid body (below) is what
   * exercises `invalid_payload` end-to-end.
   */
  it('400 on a signed body with no `id`', async () => {
    const payload = JSON.stringify({
      type: 'video.asset.ready',
      data: { passthrough: RECORDING_ID },
    });

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_payload' });
  });

  // ── THE TWO HANDLED EVENT TYPES ─────────────────────────────────────────────────────────

  it('video.asset.ready resolves by passthrough, calls markReady, enqueues cleanup + recording_ready', async () => {
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockFindRecordingById).toHaveBeenCalledWith(RECORDING_ID);
    expect(mockMarkReady).toHaveBeenCalledWith(
      expect.objectContaining({
        id: RECORDING_ID,
        muxPlaybackId: 'pb_signed',
        durationSeconds: 90,
      }),
      expect.anything()
    );
    expect(mockEnqueueRecordingCleanupSource).toHaveBeenCalledWith({ recordingId: RECORDING_ID });
    expect(mockTrackServer).toHaveBeenCalledWith(
      'recording_ready',
      expect.objectContaining({
        meeting_id: MEETING_ID,
        recording_id: RECORDING_ID,
        duration_seconds: 90,
      })
    );
  });

  /**
   * ⚠⚠ FIX ROUND 1 (F1) — a bare `await enqueueRecordingCleanupSource(...)` would let a Redis
   * blip 500 the delivery; Mux's retry then short-circuits on `processedAt` with NO enqueue and
   * NO transaction, wedging the row at `ready` with the Daily source never cleaned up. The
   * enqueue must be best-effort, and `recording_ready` — the metric §11 exists to answer — must
   * still fire even when it fails.
   */
  it('⚠⚠ a failed cleanup-source enqueue does NOT 500 — best-effort, logged, analytics still fires', async () => {
    mockEnqueueRecordingCleanupSource.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: RECORDING_ID, error: 'ECONNREFUSED' }),
      expect.stringContaining('recording-cleanup-source enqueue failed')
    );
    // ⚠ THE ORDERING — `trackServer` fires regardless of whether the enqueue below it succeeds.
    expect(mockTrackServer).toHaveBeenCalledWith(
      'recording_ready',
      expect.objectContaining({ meeting_id: MEETING_ID, recording_id: RECORDING_ID })
    );
  });

  it('⚠ resolves by the mux_asset_id FALLBACK when passthrough is absent', async () => {
    mockFindRecordingById.mockResolvedValue(undefined);
    mockFindByMuxAssetId.mockResolvedValue(RECORDING_ROW);
    const payload = body({
      data: { id: ASSET_ID, playback_ids: [{ id: 'pb_signed', policy: 'signed' }] },
    });

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockFindByMuxAssetId).toHaveBeenCalledWith(ASSET_ID);
    expect(mockMarkReady).toHaveBeenCalled();
  });

  it('⚠⚠ NO signed playback id ⇒ refuses the transition, no cleanup enqueue, no analytics', async () => {
    const payload = body({
      data: { passthrough: RECORDING_ID, playback_ids: [{ id: 'pb_pub', policy: 'public' }] },
    });

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockMarkReady).not.toHaveBeenCalled();
    expect(mockEnqueueRecordingCleanupSource).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
    expect(mockErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: RECORDING_ID }),
      expect.stringContaining('no SIGNED playback id')
    );
  });

  it('video.asset.errored calls markFailed and emits recording_failed', async () => {
    const payload = body({
      type: 'video.asset.errored',
      id: 'evt_2',
      data: { passthrough: RECORDING_ID, errors: { messages: ['transcode failed'] } },
    });

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockMarkFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: RECORDING_ID, stage: 'mux_asset', reason: 'transcode failed' }),
      expect.anything()
    );
    expect(mockTrackServer).toHaveBeenCalledWith('recording_failed', {
      meeting_id: MEETING_ID,
      stage: 'mux_asset',
      reason: 'vendor_reported',
      distinct_id: MEETING_ID,
    });
  });

  // ── ACK-AND-FORGET ──────────────────────────────────────────────────────────────────────

  it('⚠ an UNKNOWN event type records its marker and acks 200 with no effect', async () => {
    const payload = body({ type: 'video.upload.asset_created', id: 'evt_unknown' });

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockInsertReceived).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt_unknown', type: 'video.upload.asset_created' }),
      expect.anything()
    );
    expect(mockMarkReady).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockMarkProcessed).toHaveBeenCalled();
  });

  it('a delivery resolving to no row acks with a warn and no effect', async () => {
    mockFindRecordingById.mockResolvedValue(undefined);
    mockFindByMuxAssetId.mockResolvedValue(undefined);
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockMarkReady).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'video.asset.ready' }),
      expect.stringContaining('no meeting_recordings row')
    );
  });

  // ── IDEMPOTENCY ─────────────────────────────────────────────────────────────────────────

  it('⚠⚠ a fully-processed REPLAY short-circuits with NO transaction', async () => {
    mockFindByEventId.mockResolvedValue({ id: 'marker-1', processedAt: new Date() });
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockMarkReady).not.toHaveBeenCalled();
  });

  it('⚠ a marker with a NULL processed_at is NOT a replay — the retry re-applies', async () => {
    mockFindByEventId.mockResolvedValue({ id: 'marker-1', processedAt: null });
    const payload = body();

    await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(mockTransaction).toHaveBeenCalled();
  });

  it('⚠ a CONCURRENT delivery that loses the unique index applies NO effect', async () => {
    mockInsertReceived.mockResolvedValue(undefined);
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockMarkReady).not.toHaveBeenCalled();
    expect(mockMarkProcessed).not.toHaveBeenCalled();
    expect(mockEnqueueRecordingCleanupSource).not.toHaveBeenCalled();
  });

  it('stamps processed_at on the SAME executor as the effect', async () => {
    const payload = body();

    await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    const [, insertExec] = mockInsertReceived.mock.calls[0] as [unknown, unknown];
    const [, stampExec] = mockMarkProcessed.mock.calls[0] as [unknown, unknown];
    expect(stampExec).toBe(insertExec);
  });

  // ── ⚠ THE PER-IP WINDOW ────────────────────────────────────────────────────────────────

  it('⚠ consumes the PER-IP window (own keyPrefix, own budget) BEFORE the signature is verified', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, ttlSeconds: 60 });
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(503);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ keyPrefix: 'ratelimit:mux-webhook:ip', maxRequests: 2_000 }),
      expect.any(String)
    );
    expect(mockFindByEventId).not.toHaveBeenCalled();
  });

  it('⚠ 503 when the limiter is unavailable — fails closed', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('redis unreachable'));
    const payload = body();

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
    expect(mockInsertReceived).not.toHaveBeenCalled();
  });
});
