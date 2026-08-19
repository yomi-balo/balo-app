import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindBySvixId,
  mockInsertReceived,
  mockMarkProcessed,
  mockFindLiveById,
  mockStampDelivery,
  mockCheckRateLimit,
  mockTryEnqueue,
  mockFindConnectionById,
  mockWarn,
  mockErrorLog,
  mockInfo,
} = vi.hoisted(() => ({
  mockFindBySvixId: vi.fn(),
  mockInsertReceived: vi.fn(),
  mockMarkProcessed: vi.fn(),
  mockFindLiveById: vi.fn(),
  mockStampDelivery: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockTryEnqueue: vi.fn(),
  mockFindConnectionById: vi.fn(),
  mockWarn: vi.fn(),
  mockErrorLog: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mockInfo, warn: mockWarn, error: mockErrorLog }),
}));
vi.mock('@balo/db', () => ({
  db: {},
  apirocWebhookEventsRepository: {
    findBySvixId: mockFindBySvixId,
    insertReceived: mockInsertReceived,
    markProcessed: mockMarkProcessed,
  },
  calendarSubscriptionsRepository: {
    findLiveById: mockFindLiveById,
    stampDelivery: mockStampDelivery,
  },
  calendarRepository: {
    findConnectionById: mockFindConnectionById,
  },
}));
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../jobs/availability-cache.js', () => ({
  tryEnqueueAvailabilityCacheRebuild: mockTryEnqueue,
}));
// ⚠ `svix` and `../../lib/calendar-encryption.js` are DELIBERATELY NOT MOCKED. The REAL
// verifier is what the 400 rows below mean, and the real cipher is what proves the secret
// round-trips through the exact path the route uses.

import Fastify, {
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
} from 'fastify';
import { Webhook } from 'svix';
import { encryptCalendarSecret } from '../../lib/calendar-encryption.js';
import { apirocWebhookPlugin } from './webhook.js';

const CALENDAR_SUBSCRIPTION_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = 'connection-1';
const SECRET = Buffer.from('a-svix-test-secret-value-1234567890').toString('base64');
const PATH = `/webhooks/apiroc/calendar/${CALENDAR_SUBSCRIPTION_ID}`;

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventType: 'calendar.event.changed',
    timestamp: '2026-08-14T07:37:20.129Z',
    ...overrides,
  });
}

function signedHeaders(payload: string): Record<string, string> {
  const wh = new Webhook(SECRET);
  const msgId = 'msg_test123';
  const timestamp = new Date();
  const signature = wh.sign(msgId, timestamp, payload);
  return {
    'svix-id': msgId,
    'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'svix-signature': signature,
    'content-type': 'application/json',
  };
}

describe('POST /webhooks/apiroc/calendar/:calendarSubscriptionId (BAL-468 §9)', () => {
  let app: FastifyInstance;
  const originalKey = process.env.CALENDAR_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.CALENDAR_ENCRYPTION_KEY = 'a-test-key-32-bytes-minimum-ok!!';
    app = Fastify({ logger: false });
    app.setErrorHandler((_error, _request, reply) => {
      reply.status(500).send({ error: 'Internal Server Error' });
    });
    // ⚠ `apirocWebhookPlugin`, NOT the bare route — without the scoped raw-body registration
    // `request.rawBody` is undefined and every assertion below would pass for the wrong reason.
    await app.register(apirocWebhookPlugin);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (originalKey === undefined) delete process.env.CALENDAR_ENCRYPTION_KEY;
    else process.env.CALENDAR_ENCRYPTION_KEY = originalKey;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 3600 });
    mockFindLiveById.mockResolvedValue({
      id: CALENDAR_SUBSCRIPTION_ID,
      connectionId: CONNECTION_ID,
      endpointSecret: encryptCalendarSecret(SECRET),
    });
    mockFindBySvixId.mockResolvedValue(undefined);
    mockInsertReceived.mockResolvedValue({ id: 'marker-1' });
    mockMarkProcessed.mockResolvedValue(undefined);
    mockStampDelivery.mockResolvedValue(undefined);
    mockFindConnectionById.mockResolvedValue({ expertProfileId: 'expert-1' });
    mockTryEnqueue.mockResolvedValue(true);
  });

  async function call(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject(opts);
  }

  it('a correctly-signed request returns 200 (the raw-body canary)', async () => {
    const payload = body();
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(mockTryEnqueue).toHaveBeenCalledWith('expert-1', expect.anything());
    expect(mockStampDelivery).toHaveBeenCalled();
    expect(mockMarkProcessed).toHaveBeenCalled();
  });

  it('404 when the path param is not a uuid', async () => {
    const payload = body();
    const res = await call({
      method: 'POST',
      url: '/webhooks/apiroc/calendar/not-a-uuid',
      payload,
      headers: signedHeaders(payload),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('404 when there is no live subscription row for the id', async () => {
    mockFindLiveById.mockResolvedValue(undefined);
    const payload = body();
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });
    expect(res.statusCode).toBe(404);
    expect(mockCheckRateLimit).toHaveBeenCalled();
  });

  it('⚠ ordering: an invalid signature performs no DB write, no enqueue, no stampDelivery', async () => {
    const payload = body();
    const res = await call({
      method: 'POST',
      url: PATH,
      payload,
      headers: { ...signedHeaders(payload), 'svix-signature': 'v1,deadbeef' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid signature' });
    expect(mockInsertReceived).not.toHaveBeenCalled();
    expect(mockTryEnqueue).not.toHaveBeenCalled();
    expect(mockStampDelivery).not.toHaveBeenCalled();
  });

  it('400 with no signature headers at all', async () => {
    const payload = body();
    const res = await call({
      method: 'POST',
      url: PATH,
      payload,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockInsertReceived).not.toHaveBeenCalled();
  });

  it('the wire body never names the failure reason; the log does', async () => {
    const payload = body();
    await call({
      method: 'POST',
      url: PATH,
      payload,
      headers: { ...signedHeaders(payload), 'svix-signature': 'v1,deadbeef' },
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ calendarSubscriptionId: CALENDAR_SUBSCRIPTION_ID }),
      'apiroc_webhook_signature_invalid'
    );
  });

  it('replay: processedAt set → 200, no enqueue', async () => {
    mockFindBySvixId.mockResolvedValue({ id: 'marker-1', processedAt: new Date() });
    const payload = body();
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockTryEnqueue).not.toHaveBeenCalled();
    expect(mockInsertReceived).not.toHaveBeenCalled();
  });

  it('repair: marker present with processedAt NULL → DOES enqueue and marks processed', async () => {
    mockFindBySvixId.mockResolvedValue({ id: 'marker-1', processedAt: null });
    const payload = body();
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockTryEnqueue).toHaveBeenCalled();
    expect(mockMarkProcessed).toHaveBeenCalled();
  });

  it('insertReceived returns undefined (lost the race) → still enqueues, still 200', async () => {
    mockInsertReceived.mockResolvedValue(undefined);
    const payload = body();
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockTryEnqueue).toHaveBeenCalled();
  });

  it('unknown eventType → marker + 200 + NO enqueue', async () => {
    const payload = body({ eventType: 'calendar.event.unknown' });
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(200);
    expect(mockInsertReceived).toHaveBeenCalled();
    expect(mockTryEnqueue).not.toHaveBeenCalled();
    expect(mockMarkProcessed).toHaveBeenCalled();
  });

  it('⚠ a GENUINELY-SIGNED body that is not JSON → 400 invalid_payload, NOT a signature failure', async () => {
    // Reachable only because `apirocWebhookPlugin` owns its own `application/json` parser.
    // Under Fastify's built-in parser this body would 500 + fire Sentry per delivery attempt,
    // and Svix would disable the endpoint after ~5 days.
    //
    // `wh.verify` ends with `JSON.parse(payload)`, so this throws a SyntaxError — NOT a
    // WebhookVerificationError — from inside the same try as a signature failure. Collapsing
    // the two poisons the only signal that says someone is probing forged webhooks.
    const payload = 'not-json-at-all';
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_payload' });
    // Nothing was written or enqueued on the way out.
    expect(mockInsertReceived).not.toHaveBeenCalled();
    expect(mockTryEnqueue).not.toHaveBeenCalled();
    expect(mockStampDelivery).not.toHaveBeenCalled();
  });

  it('⚠ a live subscription whose connection is gone → 404, and NOT the success marker', async () => {
    // The shape a partially-failed `disconnectProvider` leaves behind. It is permanently
    // wrong, so a 503 would spend Svix's ~5-day retry budget on a condition no retry fixes.
    mockFindConnectionById.mockResolvedValue(undefined);
    const payload = body();
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect(mockTryEnqueue).not.toHaveBeenCalled();
    expect(mockMarkProcessed).not.toHaveBeenCalled();
  });

  it('enqueue returns false → 503, markProcessed NOT called', async () => {
    mockTryEnqueue.mockResolvedValue(false);
    const payload = body();
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'enqueue_failed' });
    expect(mockMarkProcessed).not.toHaveBeenCalled();
  });

  it('503 when the stored secret cannot be decrypted', async () => {
    mockFindLiveById.mockResolvedValue({
      id: CALENDAR_SUBSCRIPTION_ID,
      connectionId: CONNECTION_ID,
      endpointSecret: 'not:a:valid-ciphertext-shape',
    });
    const payload = body();
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'webhook_not_configured' });
    expect(mockInsertReceived).not.toHaveBeenCalled();
  });

  it('400 on a verified body that fails the zod boundary', async () => {
    // Sign a body with no `eventType` at all — origin verifies, shape does not.
    const payload = JSON.stringify({ timestamp: '2026-08-14T07:37:20.129Z' });
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('rate limiter rejects → 503, and signature verification is never reached', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 999, ttlSeconds: 60 });
    const payload = body();
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'rate_limited' });
    expect(mockFindLiveById).not.toHaveBeenCalled();
  });

  it('rate limiter throws → 503 (fails closed)', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('redis unreachable'));
    const payload = body();
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
  });

  it('tolerates an extra unknown field in the verified body (no .strict())', async () => {
    const payload = body({ extraField: 'something-new' });
    const res = await call({ method: 'POST', url: PATH, payload, headers: signedHeaders(payload) });
    expect(res.statusCode).toBe(200);
  });
});
