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
