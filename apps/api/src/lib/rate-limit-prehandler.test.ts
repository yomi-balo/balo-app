import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const { mockCheckRateLimit, mockWarn, mockGetRedis } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockWarn: vi.fn(),
  mockGetRedis: vi.fn(() => ({})),
}));

// ⚠ `RATE_LIMIT_DEADLINE_MS` MUST come through from the real module — a bare factory mock
// (`() => ({ checkRateLimit })`) drops it, `withDeadline` then gets `setTimeout(fn, undefined)`,
// the deadline fires on the next tick, and EVERY case here looks like a Redis outage. Same trap
// documented at `routes/experts/search.test.ts:47-56`.
vi.mock('./rate-limiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rate-limiter.js')>();
  return {
    RATE_LIMIT_DEADLINE_MS: actual.RATE_LIMIT_DEADLINE_MS,
    checkRateLimit: mockCheckRateLimit,
  };
});
vi.mock('./redis.js', () => ({ getRedis: mockGetRedis }));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));

import { createRateLimitPreHandler } from './rate-limit-prehandler.js';

const CONFIG = { keyPrefix: 'ratelimit:probe', maxRequests: 60, windowSeconds: 60 };

function fakeRequest(over: Partial<{ ip: string; userId: string }> = {}): FastifyRequest {
  return { ip: '203.0.113.9', ...over } as unknown as FastifyRequest;
}

function fakeReply() {
  const sent = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    header(key: string, value: string) {
      sent.headers[key] = value;
      return sent;
    },
    status(code: number) {
      sent.statusCode = code;
      return sent;
    },
    code(code: number) {
      sent.statusCode = code;
      return sent;
    },
    send(payload: unknown) {
      sent.body = payload;
      return sent;
    },
  };
  return sent;
}

const asReply = (reply: ReturnType<typeof fakeReply>): FastifyReply =>
  reply as unknown as FastifyReply;

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 60 });
});

describe('createRateLimitPreHandler (BAL-519)', () => {
  it('buckets on request.ip when no identifier selector is supplied', async () => {
    const handler = createRateLimitPreHandler({ config: CONFIG, failOpen: true, label: 'probe' });
    const reply = fakeReply();

    const rejected = await handler(fakeRequest(), asReply(reply));

    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.anything(), CONFIG, '203.0.113.9');
    expect(rejected).toBe(false);
    expect(reply.statusCode).toBe(0);
  });

  it('buckets on the SELECTED value when an identifier selector is supplied', async () => {
    const handler = createRateLimitPreHandler({
      config: CONFIG,
      failOpen: true,
      label: 'probe',
      identifier: (r) => r.userId,
    });

    await handler(fakeRequest({ ip: '203.0.113.9', userId: 'user_1' }), asReply(fakeReply()));

    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.anything(), CONFIG, 'user_1');
    expect(mockCheckRateLimit).not.toHaveBeenCalledWith(expect.anything(), CONFIG, '203.0.113.9');
  });

  it('two users behind ONE ip get independent buckets (AC2)', async () => {
    const handler = createRateLimitPreHandler({
      config: CONFIG,
      failOpen: true,
      label: 'probe',
      identifier: (r) => r.userId,
    });

    await handler(fakeRequest({ ip: '203.0.113.9', userId: 'user_1' }), asReply(fakeReply()));
    await handler(fakeRequest({ ip: '203.0.113.9', userId: 'user_2' }), asReply(fakeReply()));

    const thirdArgs = mockCheckRateLimit.mock.calls.map((call) => call[2]);
    expect(thirdArgs).toEqual(['user_1', 'user_2']);
  });

  it('one user across TWO ips shares one bucket (AC2)', async () => {
    const handler = createRateLimitPreHandler({
      config: CONFIG,
      failOpen: true,
      label: 'probe',
      identifier: (r) => r.userId,
    });

    await handler(fakeRequest({ ip: '203.0.113.9', userId: 'user_1' }), asReply(fakeReply()));
    await handler(fakeRequest({ ip: '198.51.100.4', userId: 'user_1' }), asReply(fakeReply()));

    const thirdArgs = mockCheckRateLimit.mock.calls.map((call) => call[2]);
    expect(thirdArgs).toEqual(['user_1', 'user_1']);
  });

  it('401s and NEVER counts when the selector returns undefined', async () => {
    const handler = createRateLimitPreHandler({
      config: CONFIG,
      failOpen: true,
      label: 'probe',
      identifier: () => undefined,
    });
    const reply = fakeReply();

    const rejected = await handler(fakeRequest(), asReply(reply));

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: 'Unauthorized' });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(rejected).toBe(true);
  });

  it("401s when the selector returns an empty string — never a shared '' bucket", async () => {
    const handler = createRateLimitPreHandler({
      config: CONFIG,
      failOpen: true,
      label: 'probe',
      identifier: () => '',
    });
    const reply = fakeReply();

    const rejected = await handler(fakeRequest(), asReply(reply));

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: 'Unauthorized' });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(rejected).toBe(true);
  });

  it('NEVER falls back to request.ip when the selector yields nothing', async () => {
    const handler = createRateLimitPreHandler({
      config: CONFIG,
      failOpen: true,
      label: 'probe',
      identifier: () => undefined,
    });

    await handler(fakeRequest({ ip: '203.0.113.9' }), asReply(fakeReply()));

    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('the default request.ip path has NO emptiness guard — still reaches checkRateLimit (R7)', async () => {
    const handler = createRateLimitPreHandler({ config: CONFIG, failOpen: true, label: 'probe' });
    const reply = fakeReply();

    const rejected = await handler(fakeRequest({ ip: '' }), asReply(reply));

    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.anything(), CONFIG, '');
    expect(reply.statusCode).toBe(0);
    expect(rejected).toBe(false);
  });

  it('429s with Retry-After and the house wire shape', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 61, ttlSeconds: 42 });
    const handler = createRateLimitPreHandler({ config: CONFIG, failOpen: true, label: 'probe' });
    const reply = fakeReply();

    const rejected = await handler(fakeRequest(), asReply(reply));

    expect(reply.statusCode).toBe(429);
    expect(reply.body).toEqual({ error: 'rate_limited', cooldownSeconds: 42 });
    expect(reply.headers['Retry-After']).toBe('42');
    expect(rejected).toBe(true);
  });

  it('logs ONE warn per 429 WITHOUT the identifier by default (no PII)', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 61, ttlSeconds: 42 });
    const handler = createRateLimitPreHandler({ config: CONFIG, failOpen: true, label: 'probe' });

    await handler(fakeRequest(), asReply(fakeReply()));

    expect(mockWarn).toHaveBeenCalledWith(
      { label: 'probe', keyPrefix: 'ratelimit:probe', current: 61, ttlSeconds: 42 },
      'Rate limit exceeded'
    );
  });

  it('logs the identifier ONLY when logIdentifier is true', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 61, ttlSeconds: 42 });
    const handler = createRateLimitPreHandler({
      config: CONFIG,
      failOpen: true,
      label: 'probe',
      identifier: (r) => r.userId,
      logIdentifier: true,
    });

    await handler(fakeRequest({ userId: 'user_1' }), asReply(fakeReply()));

    expect(mockWarn).toHaveBeenCalledWith(
      {
        label: 'probe',
        keyPrefix: 'ratelimit:probe',
        current: 61,
        ttlSeconds: 42,
        identifier: 'user_1',
      },
      'Rate limit exceeded'
    );
  });

  // SEC1 (fix round 1) — the hit log is gated on the FIRST refusal per bucket per window
  // (`current === maxRequests + 1`), not on every refused request. Un-gated, a flood against the
  // two PUBLIC IP-keyed callers would amplify itself into an equal-volume Axiom ingest.
  it('logs the FIRST refusal in a window (current === maxRequests + 1)', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 61, ttlSeconds: 42 });
    const handler = createRateLimitPreHandler({ config: CONFIG, failOpen: true, label: 'probe' });

    await handler(fakeRequest(), asReply(fakeReply()));

    expect(mockWarn).toHaveBeenCalledOnce();
  });

  it('does NOT log a subsequent refusal in the same window (current > maxRequests + 1)', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 62, ttlSeconds: 40 });
    const handler = createRateLimitPreHandler({ config: CONFIG, failOpen: true, label: 'probe' });
    const reply = fakeReply();

    const rejected = await handler(fakeRequest(), asReply(reply));

    expect(mockWarn).not.toHaveBeenCalled();
    // The 429 response itself is unaffected by the log gate — only the log line is suppressed.
    expect(reply.statusCode).toBe(429);
    expect(rejected).toBe(true);
  });

  it('logs NOTHING when the request is allowed', async () => {
    const handler = createRateLimitPreHandler({ config: CONFIG, failOpen: true, label: 'probe' });

    await handler(fakeRequest(), asReply(fakeReply()));

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('fails OPEN on a Redis error — returns false, reply untouched', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED'));
    const handler = createRateLimitPreHandler({ config: CONFIG, failOpen: true, label: 'probe' });
    const reply = fakeReply();

    const rejected = await handler(fakeRequest(), asReply(reply));

    expect(rejected).toBe(false);
    expect(reply.statusCode).toBe(0);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0]?.[1]).toContain('failing open');
  });

  it('fails CLOSED on a Redis error — 503 rate_limit_unavailable', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED'));
    const handler = createRateLimitPreHandler({ config: CONFIG, failOpen: false, label: 'probe' });
    const reply = fakeReply();

    const rejected = await handler(fakeRequest(), asReply(reply));

    expect(reply.statusCode).toBe(503);
    expect(reply.body).toEqual({ error: 'rate_limit_unavailable' });
    expect(rejected).toBe(true);
  });
});
