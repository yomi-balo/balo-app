import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply } from 'fastify';

const { mockCheckRateLimit } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
}));

// ⚠ SPREAD THE REAL MODULE. A `() => ({ checkRateLimit })` factory silently drops
// `RATE_LIMIT_DEADLINE_MS`, which `with-deadline.ts`'s caller here reads — see
// `routes/meetings/end.test.ts` for the identical trap.
vi.mock('./rate-limiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rate-limiter.js')>()),
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('./redis.js', () => ({ getRedis: () => ({}) }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  enforceMandateSetupRateLimit,
  MANDATE_SETUP_WALLET_RATE_LIMIT,
} from './setup-intent-rate-limit.js';
import { RATE_LIMIT_DEADLINE_MS } from './rate-limiter.js';

const WALLET_ID = 'wallet_1';

function createMockReply(): FastifyReply {
  const reply = {
    header: vi.fn(),
    code: vi.fn(),
    send: vi.fn(),
  };
  reply.header.mockReturnValue(reply);
  reply.code.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply as unknown as FastifyReply;
}

describe('enforceMandateSetupRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('R1 — allowed: returns false, sends nothing, checks the WALLET bucket', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 3600 });
    const reply = createMockReply();

    const refused = await enforceMandateSetupRateLimit(WALLET_ID, reply);

    expect(refused).toBe(false);
    expect(reply.code).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      MANDATE_SETUP_WALLET_RATE_LIMIT,
      WALLET_ID
    );
  });

  it('R2 — over the limit: 429 with cooldownSeconds and Retry-After', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 31, ttlSeconds: 1800 });
    const reply = createMockReply();

    const refused = await enforceMandateSetupRateLimit(WALLET_ID, reply);

    expect(refused).toBe(true);
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '1800');
    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith({ error: 'rate_limited', cooldownSeconds: 1800 });
  });

  it('R3 — checkRateLimit rejects: 503, fails CLOSED', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('redis unreachable'));
    const reply = createMockReply();

    const refused = await enforceMandateSetupRateLimit(WALLET_ID, reply);

    expect(refused).toBe(true);
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ error: 'rate_limit_unavailable' });
  });

  /**
   * R4 — the rejects-test above does NOT exercise a real Redis outage:
   * `getRedis()` sets `maxRetriesPerRequest: null`, so ioredis parks a command in its offline
   * queue instead of failing it, and the promise never settles. `withDeadline` is what makes the
   * `catch` reachable at all — see `routes/experts/availability-overrides.test.ts`'s R3 case for
   * the identical mechanism proved against the sibling limiter.
   */
  it('R4 — checkRateLimit HANGS forever: still 503 within the deadline, never hangs the caller', async () => {
    vi.useFakeTimers();
    try {
      mockCheckRateLimit.mockReturnValue(new Promise(() => {}));
      const reply = createMockReply();

      const pending = enforceMandateSetupRateLimit(WALLET_ID, reply);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_DEADLINE_MS + 1);
      const refused = await pending;

      expect(refused).toBe(true);
      expect(reply.code).toHaveBeenCalledWith(503);
      expect(reply.send).toHaveBeenCalledWith({ error: 'rate_limit_unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('R5 — config sanity: a numbers change is a deliberate edit, not a silent drift', () => {
    expect(MANDATE_SETUP_WALLET_RATE_LIMIT).toEqual({
      keyPrefix: 'ratelimit:mandate-setup:wallet',
      maxRequests: 30,
      windowSeconds: 3600,
    });
  });
});
