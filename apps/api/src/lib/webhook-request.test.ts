import { describe, expect, it, vi } from 'vitest';

const { mockCheckRateLimit } = vi.hoisted(() => ({ mockCheckRateLimit: vi.fn() }));

vi.mock('./rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('./redis.js', () => ({ getRedis: () => ({}) }));

import { decodeJsonBody, enforceWebhookIpRateLimit, enqueueBestEffort } from './webhook-request.js';
import type { RateLimitConfig } from './rate-limiter.js';

const CONFIG: RateLimitConfig = {
  keyPrefix: 'ratelimit:test-webhook:ip',
  maxRequests: 100,
  windowSeconds: 3600,
};

function fakeLog(): { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), error: vi.fn() };
}

function fakeReply(): { code: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const reply = {
    code: vi.fn(),
    send: vi.fn(),
  };
  reply.code.mockReturnValue(reply);
  return reply;
}

describe('decodeJsonBody', () => {
  it('parses a valid JSON buffer', () => {
    expect(decodeJsonBody(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
  });

  it('returns `null` (never throws) on non-JSON', () => {
    expect(decodeJsonBody(Buffer.from('not json'))).toBeNull();
  });

  it('returns `null` on an empty buffer', () => {
    expect(decodeJsonBody(Buffer.alloc(0))).toBeNull();
  });
});

describe('enforceWebhookIpRateLimit', () => {
  it('returns `false` and sends nothing when allowed', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 3600 });
    const reply = fakeReply();
    const log = fakeLog();

    const result = await enforceWebhookIpRateLimit(
      CONFIG,
      '1.2.3.4',
      reply as unknown as Parameters<typeof enforceWebhookIpRateLimit>[2],
      log as unknown as Parameters<typeof enforceWebhookIpRateLimit>[3]
    );

    expect(result).toBe(false);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('sends 503 rate_limited and returns `true` when over the limit', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 101, ttlSeconds: 10 });
    const reply = fakeReply();
    const log = fakeLog();

    const result = await enforceWebhookIpRateLimit(
      CONFIG,
      '1.2.3.4',
      reply as unknown as Parameters<typeof enforceWebhookIpRateLimit>[2],
      log as unknown as Parameters<typeof enforceWebhookIpRateLimit>[3]
    );

    expect(result).toBe(true);
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ error: 'rate_limited' });
    expect(log.warn).toHaveBeenCalled();
  });

  it('fails CLOSED (503 rate_limit_unavailable) on a Redis fault', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED'));
    const reply = fakeReply();
    const log = fakeLog();

    const result = await enforceWebhookIpRateLimit(
      CONFIG,
      '1.2.3.4',
      reply as unknown as Parameters<typeof enforceWebhookIpRateLimit>[2],
      log as unknown as Parameters<typeof enforceWebhookIpRateLimit>[3]
    );

    expect(result).toBe(true);
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ error: 'rate_limit_unavailable' });
    expect(log.error).toHaveBeenCalled();
  });
});

describe('enqueueBestEffort', () => {
  it('awaits the enqueue and logs nothing when it succeeds', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const log = fakeLog();

    await enqueueBestEffort(
      enqueue,
      { meetingId: 'm1' },
      log as unknown as Parameters<typeof enqueueBestEffort>[2],
      'enqueue failed'
    );

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('⚠ swallows a rejection and logs the context + reason — never throws', async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const log = fakeLog();

    await expect(
      enqueueBestEffort(
        enqueue,
        { meetingId: 'm1', eventId: 'evt-1' },
        log as unknown as Parameters<typeof enqueueBestEffort>[2],
        'recording-ensure enqueue failed'
      )
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'm1', eventId: 'evt-1', error: 'ECONNREFUSED' }),
      'recording-ensure enqueue failed'
    );
  });
});
