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
  mockErrorLog,
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
  mockErrorLog: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: mockErrorLog }),
}));
vi.mock('@balo/db', () => ({
  db: { transaction: mockTransaction },
  dailyWebhookEventsRepository: {
    findByEventId: mockFindByEventId,
    insertReceived: mockInsertReceived,
    markProcessed: mockMarkProcessed,
  },
  meetingsRepository: { findByDailyRoomName: mockFindByRoomName },
  meetingPresenceRepository: { closeAllOpen: mockCloseAllOpen },
}));
vi.mock('../../services/meetings/presence-writer.js', () => ({
  resolvePresenceEffect: mockResolvePresenceEffect,
  applyPresenceEffect: mockApplyPresenceEffect,
  reconcileMeetingStatus: mockReconcileStatus,
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

  // ── ACK-AND-FORGET PATHS ────────────────────────────────────────────────────────────────

  /**
   * ⚠ AN UNKNOWN TYPE MUST NEVER 500. Daily fires types Balo does not handle, and a `500` would
   * flood the retry queue and eventually get the WEBHOOK DISABLED — taking the three types we
   * DO care about down with it.
   */
  it('⚠ an UNKNOWN event type records its marker and acks 200 with no effect', async () => {
    const payload = body({ type: 'recording.started', id: 'evt_rec' });

    const res = await call({ method: 'POST', url: URL, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockInsertReceived).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt_rec', type: 'recording.started' }),
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
