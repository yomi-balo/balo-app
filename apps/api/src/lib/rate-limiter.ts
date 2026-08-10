import type { Redis } from 'ioredis';

export interface RateLimitConfig {
  keyPrefix: string;
  maxRequests: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  current: number;
  ttlSeconds: number;
}

/**
 * How long a FAIL-CLOSED limiter waits for Redis before it gives up and refuses.
 *
 * ⚠ THIS IS WHAT MAKES THE `503` REACHABLE AT ALL. `getRedis()` sets
 * `maxRetriesPerRequest: null` (BullMQ requires it), and ioredis only flushes pending
 * commands with an error when that option is a NUMBER — so with the offline queue enabled,
 * a command issued while Redis is unreachable never settles and the limiter's `catch`
 * never runs. See `with-deadline.ts` for the verified mechanism.
 *
 * 2s is chosen against the ALTERNATIVE, not against Redis's latency: a healthy `MULTI` of
 * INCR/EXPIRE/TTL answers in single-digit milliseconds, so any wait approaching this is
 * already an outage, and the thing being avoided is a request pinned until an upstream
 * proxy timeout (typically 30–60s). Generous enough to ride out a failover, short enough
 * that the caller gets a real answer.
 */
export const RATE_LIMIT_DEADLINE_MS = 2_000;

/**
 * Fixed-window rate limiter using Redis INCR + EXPIRE NX.
 *
 * Algorithm:
 * 1. INCR the key atomically (creates it at 1 if missing)
 * 2. EXPIRE NX sets TTL only if none exists (first request in window)
 * 3. TTL returns remaining seconds in the current window
 *
 * All three commands run in a MULTI/EXEC pipeline for atomicity.
 * INCR-first (count-then-check) avoids TOCTOU races — two concurrent
 * requests will each see a different counter value.
 */
export async function checkRateLimit(
  redis: Redis,
  config: RateLimitConfig,
  identifier: string
): Promise<RateLimitResult> {
  const key = `${config.keyPrefix}:${identifier}`;

  const pipeline = redis.multi();
  pipeline.incr(key);
  pipeline.expire(key, config.windowSeconds, 'NX');
  pipeline.ttl(key);

  const results = await pipeline.exec();

  // MULTI/EXEC returns [[error, value], ...] for each command, or null on abort
  if (!results || results.length < 3) {
    throw new Error('Rate limit Redis pipeline returned no results');
  }

  const [incrErr, incrVal] = results[0];
  const [ttlErr, ttlVal] = results[2];

  if (incrErr || ttlErr) {
    throw new Error(`Rate limit Redis command failed: ${(incrErr ?? ttlErr)!.message}`);
  }

  const current = incrVal as number;
  const ttlSeconds = ttlVal as number;

  return {
    allowed: current <= config.maxRequests,
    current,
    ttlSeconds,
  };
}
