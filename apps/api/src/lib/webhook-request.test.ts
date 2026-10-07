import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCheckRateLimit, mockCaptureMessage } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock('./rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('./redis.js', () => ({ getRedis: () => ({}) }));
// BAL-583 — Sentry wiring is NEW on this path; the real SDK must never run in a unit test.
vi.mock('@sentry/node', () => ({ captureMessage: mockCaptureMessage }));

import { decodeJsonBody, enforceWebhookIpRateLimit, enqueueBestEffort } from './webhook-request.js';
import type { RateLimitConfig } from './rate-limiter.js';

const MUX_CONFIG: RateLimitConfig = {
  keyPrefix: 'ratelimit:mux-webhook:ip',
  maxRequests: 2_000,
  windowSeconds: 3600,
};

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

/**
 * BAL-583 — this helper is VENDOR-NEUTRAL and shared by both webhook routes, so dedup is keyed
 * per `config.keyPrefix` — a Mux capture must never suppress a Daily one. Each
 * `it` `vi.resetModules()`s and dynamically re-imports this module so the dedup `Set` inside
 * `lib/sentry-alert.js` (unmocked, no reset export by design) starts fresh per test.
 */
describe('enforceWebhookIpRateLimit — once-per-process Sentry (BAL-583)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('captures ONCE across repeated failures on the SAME keyPrefix', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED'));
    const { enforceWebhookIpRateLimit: freshEnforce } = await import('./webhook-request.js');
    const reply = fakeReply();
    const log = fakeLog();

    const firstResult = await freshEnforce(
      CONFIG,
      '1.2.3.4',
      reply as unknown as Parameters<typeof freshEnforce>[2],
      log as unknown as Parameters<typeof freshEnforce>[3]
    );
    const secondResult = await freshEnforce(
      CONFIG,
      '1.2.3.4',
      reply as unknown as Parameters<typeof freshEnforce>[2],
      log as unknown as Parameters<typeof freshEnforce>[3]
    );

    expect(firstResult).toBe(true);
    expect(secondResult).toBe(true);
    expect(reply.code).toHaveBeenNthCalledWith(1, 503);
    expect(reply.send).toHaveBeenNthCalledWith(1, { error: 'rate_limit_unavailable' });
    expect(reply.code).toHaveBeenNthCalledWith(2, 503);
    expect(reply.send).toHaveBeenNthCalledWith(2, { error: 'rate_limit_unavailable' });
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      { error: 'ECONNREFUSED' },
      "Webhook rate limit unavailable — failing CLOSED with 503; whether the delivery is redelivered depends on the vendor's retry policy"
    );
  });

  it('a DIFFERENT keyPrefix (Mux) captures AGAIN — one vendor cannot suppress another', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('ECONNREFUSED'));
    const { enforceWebhookIpRateLimit: freshEnforce } = await import('./webhook-request.js');
    const reply = fakeReply();
    const log = fakeLog();

    await freshEnforce(
      CONFIG,
      '1.2.3.4',
      reply as unknown as Parameters<typeof freshEnforce>[2],
      log as unknown as Parameters<typeof freshEnforce>[3]
    );
    await freshEnforce(
      MUX_CONFIG,
      '1.2.3.4',
      reply as unknown as Parameters<typeof freshEnforce>[2],
      log as unknown as Parameters<typeof freshEnforce>[3]
    );

    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
    const calls = mockCaptureMessage.mock.calls as [string, unknown][];
    const [dailyCall] = calls;
    const [muxCall] = calls.slice(1);
    if (dailyCall === undefined || muxCall === undefined) {
      throw new Error('expected two captures');
    }
    const [dailyMessage] = dailyCall;
    const [muxMessage] = muxCall;
    expect(dailyMessage).toContain(CONFIG.keyPrefix);
    expect(dailyMessage).not.toContain('Daily');
    expect(muxMessage).toContain(MUX_CONFIG.keyPrefix);
    expect(muxMessage).not.toContain('Daily');
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
