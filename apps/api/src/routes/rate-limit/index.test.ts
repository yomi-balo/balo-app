import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const { mockCheckRateLimit, mockGetRedis, mockWarn, withDeadlineSpy } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockGetRedis: vi.fn(() => ({ status: 'ready' }) as { status: string }),
  mockWarn: vi.fn(),
  withDeadlineSpy: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));

// ⚠ SPREAD `importOriginal` — a bare factory mock would silently drop this module's OTHER
// exports (`RATE_LIMIT_DEADLINE_MS`, `RateLimitConfig`) for anything else `buildApp()` pulls
// in transitively. Same trap documented at `sessions/index.test.ts:70-73`.
vi.mock('../../lib/rate-limiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/rate-limiter.js')>();
  return { ...actual, checkRateLimit: mockCheckRateLimit };
});

vi.mock('../../lib/redis.js', () => ({ getRedis: mockGetRedis }));

// The real deadline race still runs (needed by the "never settles" case below) — this only
// records the call args so a test can assert the route bounds its Redis check by
// RATE_LIMIT_CHECK_DEADLINE_MS, not some other value.
vi.mock('../../lib/with-deadline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/with-deadline.js')>();
  return {
    ...actual,
    withDeadline: (
      operation: () => Promise<unknown>,
      options: { deadlineMs: number; label: string }
    ) => {
      withDeadlineSpy(operation, options);
      return actual.withDeadline(operation, options);
    },
  };
});

import type { FastifyInstance, InjectOptions } from 'fastify';
import { RATE_LIMIT_CHECK_PATH, RATE_LIMIT_CHECK_DEADLINE_MS } from '@balo/shared/rate-limit';
import { buildApp } from '../../app.js';
import { RATE_LIMIT_EXCEEDED_LOG_MESSAGE } from '../../lib/rate-limit-prehandler.js';
import {
  RATE_LIMIT_REDIS_UNAVAILABLE_LOG_MESSAGE,
  RATE_LIMIT_UNAUTHORIZED_LOG_MESSAGE,
} from './index.js';
import { WEB_RATE_LIMIT_BUCKET_CONFIGS } from './buckets.js';

const TEST_SECRET = 'test-internal-secret';
const USER_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('POST /rate-limit/check (BAL-461)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = TEST_SECRET;
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_API_SECRET;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedis.mockReturnValue({ status: 'ready' });
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 60 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Defaults to the shared `app` built above; tests that touch a route-scoped log gate build
  // and pass their own app instead, so the gate they observe isn't shared with any other test.
  function inject(
    payload?: Record<string, unknown>,
    headers?: Record<string, string>,
    targetApp: FastifyInstance = app
  ) {
    const options: InjectOptions = {
      method: 'POST',
      url: RATE_LIMIT_CHECK_PATH,
      headers: { 'x-internal-api-key': TEST_SECRET, ...headers },
    };
    if (payload !== undefined) {
      options.payload = payload;
    }
    return targetApp.inject(options);
  }

  // ── Auth boundary ──────────────────────────────────────────────────────

  it('401s with a missing key, and never calls checkRateLimit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: RATE_LIMIT_CHECK_PATH,
      payload: { bucket: 'meeting-chat-post', userId: USER_ID },
    });
    expect(res.statusCode).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('401s with a wrong key, and never calls checkRateLimit', async () => {
    const res = await inject(
      { bucket: 'meeting-chat-post', userId: USER_ID },
      { 'x-internal-api-key': 'wrong-key' }
    );
    expect(res.statusCode).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('500s when the api secret is unset', async () => {
    delete process.env.INTERNAL_API_SECRET;
    try {
      const res = await inject({ bucket: 'meeting-chat-post', userId: USER_ID });
      expect(res.statusCode).toBe(500);
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
    } finally {
      process.env.INTERNAL_API_SECRET = TEST_SECRET;
    }
  });

  // A fresh app so the gate this asserts on hasn't been touched by any other test.
  it('logs one gated warn across two unauthorized requests, with no key or IP in it', async () => {
    const freshApp = await buildApp({ logger: false });
    try {
      const first = await inject(
        { bucket: 'meeting-chat-post', userId: USER_ID },
        { 'x-internal-api-key': 'wrong-key' },
        freshApp
      );
      const second = await inject(
        { bucket: 'meeting-chat-post', userId: USER_ID },
        { 'x-internal-api-key': 'wrong-key' },
        freshApp
      );
      expect(first.statusCode).toBe(401);
      expect(second.statusCode).toBe(401);
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ suppressed: 0 }),
        RATE_LIMIT_UNAUTHORIZED_LOG_MESSAGE
      );
      expect(mockWarn.mock.calls[0]?.[0]).not.toHaveProperty('ip');
      expect(mockWarn.mock.calls[0]?.[0]).not.toHaveProperty('key');
      // Verbatim pin — not just "the same constant both sides reference".
      expect(RATE_LIMIT_UNAUTHORIZED_LOG_MESSAGE).toBe('Unauthorized rate-limit check request');
    } finally {
      await freshApp.close();
    }
  });

  it('rejects a wrong key before the body is read — an oversized body still 401s, never 413', async () => {
    const res = await app.inject({
      method: 'POST',
      url: RATE_LIMIT_CHECK_PATH,
      headers: { 'x-internal-api-key': 'wrong-key', 'content-type': 'application/json' },
      payload: JSON.stringify({
        bucket: 'meeting-chat-post',
        userId: USER_ID,
        padding: 'x'.repeat(2000),
      }),
    });
    expect(res.statusCode).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('rejects a wrong key before the body is read — malformed JSON still 401s, never 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: RATE_LIMIT_CHECK_PATH,
      headers: { 'x-internal-api-key': 'wrong-key', 'content-type': 'application/json' },
      payload: '{not valid json',
    });
    expect(res.statusCode).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('413s an oversized body even with a valid key, and never reaches checkRateLimit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: RATE_LIMIT_CHECK_PATH,
      headers: { 'x-internal-api-key': TEST_SECRET, 'content-type': 'application/json' },
      payload: JSON.stringify({
        bucket: 'meeting-chat-post',
        userId: USER_ID,
        padding: 'x'.repeat(2000),
      }),
    });
    expect(res.statusCode).toBe(413);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  // A non-413 body-parsing failure (malformed JSON) must NOT be swallowed as a 413 — the
  // route's errorHandler re-throws anything that isn't statusCode 413, so it reaches the app's
  // own global handler (app.ts) and gets that handler's exact reply shape, never touching
  // checkRateLimit. Raced against a timeout: if the errorHandler ever stopped re-throwing and
  // instead swallowed the error without sending a reply, this request would hang forever rather
  // than fail — light-my-request's inject() has no built-in call timeout, so nothing else would
  // catch that here.
  it('re-throws a non-413 body-parsing error to the app’s own global handler, and completes rather than hanging', async () => {
    const injected = app.inject({
      method: 'POST',
      url: RATE_LIMIT_CHECK_PATH,
      headers: { 'x-internal-api-key': TEST_SECRET, 'content-type': 'application/json' },
      payload: '{not valid json',
    });
    const timedOut = Symbol('timed out');
    const res = await Promise.race([
      injected,
      new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 2000)),
    ]);
    if (res === timedOut) {
      throw new Error('the request never completed — the errorHandler swallowed the error');
    }
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  // ── Body validation ────────────────────────────────────────────────────

  it.each([
    ['an unknown bucket', { bucket: 'not-a-real-bucket', userId: USER_ID }],
    ['a non-uuid userId', { bucket: 'meeting-chat-post', userId: 'not-a-uuid' }],
    ['an extra key', { bucket: 'meeting-chat-post', userId: USER_ID, extra: 'nope' }],
    ['a missing bucket', { userId: USER_ID }],
    ['a missing userId', { bucket: 'meeting-chat-post' }],
  ])('400s on %s, and never calls checkRateLimit', async (_label, payload) => {
    const res = await inject(payload);
    expect(res.statusCode).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('accepts a raw JSON string body with an explicit content-type header — the real web wire shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: RATE_LIMIT_CHECK_PATH,
      headers: { 'x-internal-api-key': TEST_SECRET, 'content-type': 'application/json' },
      payload: JSON.stringify({ bucket: 'meeting-chat-post', userId: USER_ID }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ allowed: true });
  });

  // ── Allowed ────────────────────────────────────────────────────────────

  it("200s { allowed: true } and calls checkRateLimit with that bucket's config and the userId", async () => {
    const res = await inject({ bucket: 'meeting-reaction', userId: USER_ID });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ allowed: true });
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      WEB_RATE_LIMIT_BUCKET_CONFIGS['meeting-reaction'],
      USER_ID
    );
  });

  it('logs nothing on an allowed request', async () => {
    await inject({ bucket: 'meeting-chat-post', userId: USER_ID });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('bounds the Redis check by RATE_LIMIT_CHECK_DEADLINE_MS, not some other deadline', async () => {
    await inject({ bucket: 'meeting-chat-post', userId: USER_ID });
    expect(withDeadlineSpy).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ deadlineMs: RATE_LIMIT_CHECK_DEADLINE_MS })
    );
  });

  // ── Refused ────────────────────────────────────────────────────────────

  it('429s with Retry-After and cooldownSeconds from the limiter TTL', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 31, ttlSeconds: 42 });
    const res = await inject({ bucket: 'meeting-chat-post', userId: USER_ID });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'rate_limited', cooldownSeconds: 42 });
    expect(res.headers['retry-after']).toBe('42');
  });

  it('passes a TTL of 0 through unchanged — not the window fallback', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 31, ttlSeconds: 0 });
    const res = await inject({ bucket: 'meeting-chat-post', userId: USER_ID });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'rate_limited', cooldownSeconds: 0 });
    expect(res.headers['retry-after']).toBe('0');
  });

  it("a TTL of -1 becomes the bucket's window", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 31, ttlSeconds: -1 });
    const res = await inject({ bucket: 'meeting-chat-post', userId: USER_ID });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'rate_limited', cooldownSeconds: 60 });
    expect(res.headers['retry-after']).toBe('60');
  });

  it('logs the refusal at current 121 (maxRequests 120 → the first refusal) with the verbatim message and the userId', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 121, ttlSeconds: 30 });
    await inject({ bucket: 'typing-signal', userId: USER_ID });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'web-rate-limit',
        bucket: 'typing-signal',
        current: 121,
        userId: USER_ID,
      }),
      RATE_LIMIT_EXCEEDED_LOG_MESSAGE
    );
    expect(RATE_LIMIT_EXCEEDED_LOG_MESSAGE).toBe('Rate limit exceeded');
  });

  it('logs again at current 241 (the second re-arm point, maxRequests 120)', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 241, ttlSeconds: 30 });
    await inject({ bucket: 'typing-signal', userId: USER_ID });
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('stays silent at current 122 — between re-arm points (maxRequests 120)', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 122, ttlSeconds: 30 });
    const res = await inject({ bucket: 'typing-signal', userId: USER_ID });
    expect(mockWarn).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
  });

  // ── Redis unavailable → 503, gated log ──────────────────────────────────
  //
  // Each case here builds its OWN app (and so its own log gate, created fresh inside the
  // plugin closure) rather than reusing the shared `app` above, so a test can be run alone
  // (`vitest run ... -t "<name>"`) and still see exactly the sequence of calls it makes itself.

  describe('Redis unavailable', () => {
    it('answers 503 on a Redis rejection, and the gated log fires on the very first occurrence', async () => {
      const freshApp = await buildApp({ logger: false });
      try {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED'));
        const res = await inject(
          { bucket: 'meeting-chat-post', userId: USER_ID },
          undefined,
          freshApp
        );
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(
          expect.objectContaining({ bucket: 'meeting-chat-post', suppressed: 0 }),
          RATE_LIMIT_REDIS_UNAVAILABLE_LOG_MESSAGE
        );
        // Verbatim pin — not just "the same constant both sides reference".
        expect(RATE_LIMIT_REDIS_UNAVAILABLE_LOG_MESSAGE).toBe(
          'Rate-limit Redis unavailable — answering 503'
        );
      } finally {
        await freshApp.close();
      }
    });

    it('suppresses a second outage inside the same 60s window, then re-admits after the interval elapses', async () => {
      const freshApp = await buildApp({ logger: false });
      try {
        const BASE_TIME = 1_700_000_000_000;
        const dateSpy = vi.spyOn(Date, 'now');
        mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED'));

        dateSpy.mockReturnValue(BASE_TIME);
        const first = await inject(
          { bucket: 'meeting-chat-post', userId: USER_ID },
          undefined,
          freshApp
        );
        expect(first.statusCode).toBe(503);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        mockWarn.mockClear();

        dateSpy.mockReturnValue(BASE_TIME + 1_000);
        const second = await inject(
          { bucket: 'meeting-chat-post', userId: USER_ID },
          undefined,
          freshApp
        );
        expect(second.statusCode).toBe(503);
        expect(mockWarn).not.toHaveBeenCalled();

        dateSpy.mockReturnValue(BASE_TIME + 61_000);
        const third = await inject(
          { bucket: 'meeting-chat-post', userId: USER_ID },
          undefined,
          freshApp
        );
        expect(third.statusCode).toBe(503);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(
          expect.objectContaining({ suppressed: 1 }),
          RATE_LIMIT_REDIS_UNAVAILABLE_LOG_MESSAGE
        );
      } finally {
        await freshApp.close();
      }
    });

    it('answers 503 on a "reconnecting" Redis status without ever calling checkRateLimit, and logs it', async () => {
      const freshApp = await buildApp({ logger: false });
      try {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        mockGetRedis.mockReturnValue({ status: 'reconnecting' });
        const res = await inject(
          { bucket: 'meeting-chat-post', userId: USER_ID },
          undefined,
          freshApp
        );
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
        expect(mockCheckRateLimit).not.toHaveBeenCalled();
        expect(mockWarn).toHaveBeenCalledWith(
          expect.objectContaining({
            bucket: 'meeting-chat-post',
            error: 'Redis not ready (status: reconnecting)',
          }),
          RATE_LIMIT_REDIS_UNAVAILABLE_LOG_MESSAGE
        );
      } finally {
        await freshApp.close();
      }
    });

    it('answers 503 when checkRateLimit never settles, within 1s (a wall-clock smoke check)', async () => {
      const freshApp = await buildApp({ logger: false });
      try {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        mockCheckRateLimit.mockImplementation(() => new Promise(() => {}));
        const started = performance.now();
        const res = await inject(
          { bucket: 'meeting-chat-post', userId: USER_ID },
          undefined,
          freshApp
        );
        expect(performance.now() - started).toBeLessThan(1000);
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'rate_limit_unavailable' });
      } finally {
        await freshApp.close();
      }
    });

    it('answers 503 and logs a non-Error rejection by its stringified message', async () => {
      const freshApp = await buildApp({ logger: false });
      try {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        mockCheckRateLimit.mockRejectedValue('boom');
        const res = await inject(
          { bucket: 'meeting-chat-post', userId: USER_ID },
          undefined,
          freshApp
        );
        expect(res.statusCode).toBe(503);
        expect(mockWarn).toHaveBeenCalledWith(
          expect.objectContaining({ bucket: 'meeting-chat-post', error: 'boom' }),
          RATE_LIMIT_REDIS_UNAVAILABLE_LOG_MESSAGE
        );
      } finally {
        await freshApp.close();
      }
    });
  });
});
