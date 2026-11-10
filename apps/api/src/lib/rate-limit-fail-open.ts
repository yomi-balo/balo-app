import type { FastifyReply, FastifyRequest } from 'fastify';
import { checkRateLimit, RATE_LIMIT_DEADLINE_MS, type RateLimitConfig } from './rate-limiter.js';
import { getRedis } from './redis.js';
import { withDeadline } from './with-deadline.js';

/**
 * Fixed-window rate limit for a READ whose caller has a safe fallback, so a limiter outage
 * must not turn into friction: it fails OPEN.
 *
 * Bounded via `withDeadline`, not a bare `try/catch`: `getRedis()` sets
 * `maxRetriesPerRequest: null` (BullMQ requires it), so during a Redis outage a command parks
 * in the offline queue and never settles. An unbounded `await` would hang the request instead
 * of reaching the `catch`. See `with-deadline.ts` for the verified mechanism.
 *
 * Returns `true` when the request was rate-limited and the 429 has been sent — the caller
 * must `return` without sending anything else.
 */
export async function enforceRateLimitFailOpen(
  request: FastifyRequest,
  reply: FastifyReply,
  config: RateLimitConfig,
  userId: string,
  label: string
): Promise<boolean> {
  try {
    const result = await withDeadline(() => checkRateLimit(getRedis(), config, userId), {
      deadlineMs: RATE_LIMIT_DEADLINE_MS,
      label,
    });
    if (!result.allowed) {
      reply
        .header('Retry-After', String(result.ttlSeconds))
        .status(429)
        .send({ error: 'rate_limited', cooldownSeconds: result.ttlSeconds });
      return true;
    }
  } catch (err: unknown) {
    request.log.warn(
      { userId, error: err instanceof Error ? err.message : String(err) },
      `${label} unavailable — failing open`
    );
  }
  return false;
}
