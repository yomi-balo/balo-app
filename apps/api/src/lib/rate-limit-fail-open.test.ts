import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const { mockCheckRateLimit } = vi.hoisted(() => ({ mockCheckRateLimit: vi.fn() }));

vi.mock('./rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('./redis.js', () => ({ getRedis: () => ({}) }));

import { enforceRateLimitFailOpen } from './rate-limit-fail-open.js';

const CONFIG = { keyPrefix: 'ratelimit:test', maxRequests: 5, windowSeconds: 60 };

function makeReply() {
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  const header = vi.fn(() => ({ status }));
  return { reply: { header } as unknown as FastifyReply, header, send, status };
}

function makeRequest() {
  const warn = vi.fn();
  return { request: { log: { warn } } as unknown as FastifyRequest, warn };
}

describe('enforceRateLimitFailOpen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false and sends nothing when the request is allowed', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 60 });
    const { reply, header } = makeReply();
    const { request } = makeRequest();

    await expect(enforceRateLimitFailOpen(request, reply, CONFIG, 'user-1', 'test')).resolves.toBe(
      false
    );
    expect(header).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).toHaveBeenCalledWith({}, CONFIG, 'user-1');
  });

  it('sends a 429 with Retry-After and returns true when blocked', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 6, ttlSeconds: 42 });
    const { reply, header, status, send } = makeReply();
    const { request } = makeRequest();

    await expect(enforceRateLimitFailOpen(request, reply, CONFIG, 'user-1', 'test')).resolves.toBe(
      true
    );
    expect(header).toHaveBeenCalledWith('Retry-After', '42');
    expect(status).toHaveBeenCalledWith(429);
    expect(send).toHaveBeenCalledWith({ error: 'rate_limited', cooldownSeconds: 42 });
  });

  it('fails open and logs a warning when the limiter throws', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('redis down'));
    const { reply, header } = makeReply();
    const { request, warn } = makeRequest();

    await expect(enforceRateLimitFailOpen(request, reply, CONFIG, 'user-1', 'test')).resolves.toBe(
      false
    );
    expect(header).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { userId: 'user-1', error: 'redis down' },
      'test unavailable — failing open'
    );
  });
});
