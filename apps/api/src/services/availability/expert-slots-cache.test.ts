import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockComputeExpertSlots, mockRedisGet, mockRedisSet, mockGetRedis } = vi.hoisted(() => {
  const redisGet = vi.fn();
  const redisSet = vi.fn();
  return {
    mockComputeExpertSlots: vi.fn(),
    mockRedisGet: redisGet,
    mockRedisSet: redisSet,
    mockGetRedis: vi.fn(() => ({ get: redisGet, set: redisSet })),
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: mockGetRedis }));
vi.mock('./expert-slots.js', () => ({ computeExpertSlots: mockComputeExpertSlots }));

import {
  AVAILABILITY_BREAKER_TTL_SECONDS,
  AVAILABILITY_CACHE_DEADLINE_MS,
  getExpertSlots,
} from './expert-slots-cache.js';

const BREAKER_KEY = 'availability:breaker:v1:66666666-6666-4666-8666-666666666666';
const AVAILABILITY_KEY = 'availability:v1:66666666-6666-4666-8666-666666666666';

/** Answers `value` for `key` and `null` (a miss) for every other key. */
function redisGetOnly(key: string, value: unknown): (k: string) => Promise<string | null> {
  return (k: string) => Promise.resolve(k === key ? JSON.stringify(value) : null);
}

const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_EXPERT_PROFILE_ID = '77777777-7777-4777-8777-777777777777';
const NOW = new Date('2026-09-07T00:00:00.000Z');

const OK_RESULT = {
  status: 'ok' as const,
  expertTimezone: 'UTC',
  generatedAt: NOW,
  slots: [{ startAt: new Date('2026-09-07T09:00:00Z'), maxDurationMinutes: 60 as const }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockComputeExpertSlots.mockResolvedValue(OK_RESULT);
});

describe('getExpertSlots — Redis cache', () => {
  it('a cache hit skips computeExpertSlots entirely', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        v: 1,
        status: 'ok',
        tz: 'UTC',
        at: NOW.toISOString(),
        slots: [{ s: '2026-09-07T09:00:00.000Z', d: 60 }],
      })
    );
    const result = await getExpertSlots(EXPERT_PROFILE_ID, NOW);
    expect(mockComputeExpertSlots).not.toHaveBeenCalled();
    expect(result.status).toBe('ok');
    expect(result.slots).toHaveLength(1);
  });

  it('a cache miss computes live and writes the cache', async () => {
    const result = await getExpertSlots(EXPERT_PROFILE_ID, NOW);
    expect(mockComputeExpertSlots).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ok');
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const [key, value, mode, ttl] = mockRedisSet.mock.calls[0] as [string, string, string, number];
    expect(key).toBe(`availability:v1:${EXPERT_PROFILE_ID}`);
    expect(mode).toBe('EX');
    expect(ttl).toBe(60);
    const written = JSON.parse(value) as { status: string };
    expect(written.status).toBe('ok');
  });

  it('unavailable is NEVER written to the availability key (D13)', async () => {
    mockComputeExpertSlots.mockResolvedValue({
      status: 'unavailable',
      expertTimezone: 'UTC',
      generatedAt: NOW,
      slots: [],
    });
    const result = await getExpertSlots(EXPERT_PROFILE_ID, NOW);
    expect(result.status).toBe('unavailable');
    const keysWritten = mockRedisSet.mock.calls.map((call) => (call as [string])[0]);
    expect(keysWritten).not.toContain(AVAILABILITY_KEY);
  });

  it('expert_not_found is NEVER written to Redis', async () => {
    mockComputeExpertSlots.mockResolvedValue({
      status: 'expert_not_found',
      expertTimezone: '',
      generatedAt: NOW,
      slots: [],
    });
    const result = await getExpertSlots(EXPERT_PROFILE_ID, NOW);
    expect(result.status).toBe('expert_not_found');
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('a Redis GET error falls open to a live compute', async () => {
    mockRedisGet.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await getExpertSlots(EXPERT_PROFILE_ID, NOW);
    expect(mockComputeExpertSlots).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ok');
  });

  it('a Redis SET error is swallowed — the live result is still returned', async () => {
    mockRedisSet.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await getExpertSlots(EXPERT_PROFILE_ID, NOW);
    expect(result.status).toBe('ok');
  });

  it('two concurrent calls for the same expert produce ONE compute (single-flight)', async () => {
    // Both calls fire in the same synchronous tick, before either's `await redis.get(...)`
    // settles — the in-process `inflight` map coalesces them into one `computeExpertSlots`.
    const [r1, r2] = await Promise.all([
      getExpertSlots(EXPERT_PROFILE_ID, NOW),
      getExpertSlots(EXPERT_PROFILE_ID, NOW),
    ]);
    expect(mockComputeExpertSlots).toHaveBeenCalledTimes(1);
    expect(r1.status).toBe('ok');
    expect(r2.status).toBe('ok');
  });

  it('two different experts produce two computes', async () => {
    await Promise.all([
      getExpertSlots(EXPERT_PROFILE_ID, NOW),
      getExpertSlots(OTHER_EXPERT_PROFILE_ID, NOW),
    ]);
    expect(mockComputeExpertSlots).toHaveBeenCalledTimes(2);
  });

  it('a well-formed-but-wrong cached payload is refused, not trusted', async () => {
    // `v: 2` — a shape this build does not understand. `tz` ships straight to the browser as
    // `expertTimezone`, so falling through to a live compute is the only safe answer.
    mockRedisGet.mockImplementation(
      redisGetOnly(AVAILABILITY_KEY, { v: 2, status: 'ok', tz: 'Mars/Olympus', at: 'nonsense' })
    );
    const result = await getExpertSlots(EXPERT_PROFILE_ID, NOW);
    expect(mockComputeExpertSlots).toHaveBeenCalledTimes(1);
    expect(result.expertTimezone).toBe('UTC');
  });
});

/**
 * ⚠ WHY A BREAKER EXISTS AT ALL, given D13 forbids caching `unavailable`.
 *
 * D13 is about not serving a fail-closed result AS AVAILABILITY, and `isCacheable` still
 * refuses to. But leaving the path entirely uncached meant EVERY subsequent anonymous request
 * re-ran the full fan-out including a live `freeBusy.get`: the in-process single-flight bounds
 * CONCURRENCY, never RATE. Because the vendor port is shared with the booking gate — which
 * fails closed on vendor error — sustained anonymous traffic during an Apiroc blip could hold a
 * named expert UNBOOKABLE via `POST /meetings`. The marker below caches a different fact ("the
 * last attempt failed"), under a different key, for a fraction of the TTL.
 */
describe('getExpertSlots — the fail-closed breaker', () => {
  it('writes a breaker MARKER (separate key, short TTL) when the vendor read fails', async () => {
    mockComputeExpertSlots.mockResolvedValue({
      status: 'unavailable',
      expertTimezone: 'UTC',
      generatedAt: NOW,
      slots: [],
    });

    await getExpertSlots(EXPERT_PROFILE_ID, NOW);

    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const [key, value, mode, ttl] = mockRedisSet.mock.calls[0] as [string, string, string, number];
    expect(key).toBe(BREAKER_KEY);
    expect(key).not.toBe(AVAILABILITY_KEY);
    expect(JSON.parse(value)).toEqual({ v: 1, breaker: 'unavailable' });
    // The marker EXPIRES — this is what stops one blip becoming a lasting outage.
    expect(mode).toBe('EX');
    expect(ttl).toBe(AVAILABILITY_BREAKER_TTL_SECONDS);
    expect(ttl).toBeLessThan(60); // strictly shorter than the availability TTL
  });

  it('an open breaker answers unavailable WITHOUT touching the DB or the vendor', async () => {
    mockRedisGet.mockImplementation(redisGetOnly(BREAKER_KEY, { v: 1, breaker: 'unavailable' }));

    const result = await getExpertSlots(EXPERT_PROFILE_ID, NOW);

    expect(result.status).toBe('unavailable');
    // THE assertion: no compute means no `findResolverSettings`, no three repository reads, and
    // no `vendorBusyProvider.listBusyBlocks` fan-out.
    expect(mockComputeExpertSlots).not.toHaveBeenCalled();
  });

  it('once the marker has expired (a miss), the next request computes live again', async () => {
    // Redis answers `null` for the breaker key — exactly what an elapsed TTL looks like.
    mockRedisGet.mockResolvedValue(null);

    const result = await getExpertSlots(EXPERT_PROFILE_ID, NOW);

    expect(mockComputeExpertSlots).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ok');
  });

  it('a still-valid cached availability answer wins over an open breaker', async () => {
    // Both keys are populated: the ok grid was cached before the vendor started failing. Serving
    // it is correct — it is a real answer, not a fail-closed one.
    mockRedisGet.mockImplementation((key: string) =>
      Promise.resolve(
        key === AVAILABILITY_KEY
          ? JSON.stringify({
              v: 1,
              status: 'ok',
              tz: 'UTC',
              at: NOW.toISOString(),
              slots: [{ s: '2026-09-07T09:00:00.000Z', d: 60 }],
            })
          : JSON.stringify({ v: 1, breaker: 'unavailable' })
      )
    );

    const result = await getExpertSlots(EXPERT_PROFILE_ID, NOW);

    expect(result.status).toBe('ok');
    expect(mockComputeExpertSlots).not.toHaveBeenCalled();
  });
});

/**
 * ⚠ THE FAIL-OPEN `catch` IS ONLY REACHABLE BECAUSE OF `withDeadline`. `getRedis()` sets
 * `maxRetriesPerRequest: null`, so a command issued while Redis is unreachable is parked in the
 * offline queue and never settles — the docblock's "falls back to a live compute" would be a
 * lie and the request would hang instead. Same mechanism as the rate limiter's; different fail
 * direction.
 */
describe('getExpertSlots — Redis that never answers', () => {
  it('falls open to a live compute when the cache GET never settles', async () => {
    vi.useFakeTimers();
    try {
      mockRedisGet.mockReturnValue(new Promise(() => {}));

      const pending = getExpertSlots(EXPERT_PROFILE_ID, NOW);
      await vi.advanceTimersByTimeAsync(AVAILABILITY_CACHE_DEADLINE_MS * 2 + 2);
      const result = await pending;

      expect(result.status).toBe('ok');
      expect(mockComputeExpertSlots).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still returns the computed result when the cache SET never settles', async () => {
    vi.useFakeTimers();
    try {
      mockRedisSet.mockReturnValue(new Promise(() => {}));

      const pending = getExpertSlots(EXPERT_PROFILE_ID, NOW);
      await vi.advanceTimersByTimeAsync(AVAILABILITY_CACHE_DEADLINE_MS + 1);

      expect((await pending).status).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});
