import type { FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@balo/shared/logging';
import { getRedis } from './redis.js';
import { checkRateLimit, RATE_LIMIT_DEADLINE_MS, type RateLimitConfig } from './rate-limiter.js';
import { withDeadline } from './with-deadline.js';

const log = createLogger('rate-limit-prehandler');

export interface RateLimitPreHandlerOptions {
  config: RateLimitConfig;
  /** `true` → a Redis error lets the request through; `false` → 503. */
  failOpen: boolean;
  /** Log scope, e.g. `'expert-search'`. */
  label: string;
}

/**
 * Shared rate-limit preHandler factory. Extracted from `routes/experts/search.ts`'s
 * module-private `enforceRateLimit` (BAL-236) — a second near-identical copy for the new
 * availability route would have been a guaranteed jscpd duplication hit.
 *
 * ⚠ Preserve the `Promise<boolean>` return exactly — `true` means the request was already
 * handled (429 or, when `failOpen: false`, 503) and the caller MUST stop; `false` means
 * continue. This is behaviour-identical to `search.ts`'s original for that existing caller.
 *
 * Two fail modes, by `failOpen`:
 *   - `failOpen: true` — a Redis error lets the request through uncounted. Appropriate when
 *     the cost of a miss is a cheap Postgres read (search).
 *   - `failOpen: false` — a Redis error answers `503 { error: 'rate_limit_unavailable' }`.
 *     Appropriate when the cost of a miss is a third-party vendor round-trip AND the response
 *     cache sitting in front of it is ALSO Redis, so a Redis outage removes the cache and the
 *     limiter at the same moment (BAL-236 availability route).
 *
 * ⚠⚠ `withDeadline` IS WHAT MAKES EITHER FAIL MODE REACHABLE AT ALL. `getRedis()` sets
 * `maxRetriesPerRequest: null` (BullMQ requires it) and ioredis only flushes pending commands
 * with an error when that option is a NUMBER — so with the offline queue enabled, a command
 * issued during a Redis outage NEVER SETTLES. Without the deadline the `catch` below is dead
 * code during the exact outage it was written for: no 503 is ever sent, the request hangs
 * holding a Fastify connection until an upstream proxy kills it, and `failOpen: false` is a
 * documented lie. See `with-deadline.ts` for the verified ioredis mechanism, and
 * `routes/meetings/join.ts` for the same pattern on the meetings surface.
 *
 * This bound covers BOTH callers. `/experts/search` (fail-OPEN) carried the identical
 * missing-deadline defect on `main` since BAL-246 — the extraction inherited it rather than
 * introducing it, and fixing it here fixes both routes at once: search now genuinely fails open
 * within 2s instead of hanging.
 */
export function createRateLimitPreHandler(
  options: RateLimitPreHandlerOptions
): (request: FastifyRequest, reply: FastifyReply) => Promise<boolean> {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    try {
      const result = await withDeadline(
        () => checkRateLimit(getRedis(), options.config, request.ip),
        { deadlineMs: RATE_LIMIT_DEADLINE_MS, label: `rate limit ${options.config.keyPrefix}` }
      );
      if (!result.allowed) {
        reply
          .header('Retry-After', String(result.ttlSeconds))
          .status(429)
          .send({ error: 'rate_limited', cooldownSeconds: result.ttlSeconds });
        return true;
      }
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.failOpen) {
        log.warn(
          { label: options.label, error: message },
          'Rate-limit Redis unavailable — failing open'
        );
        return false;
      }
      log.warn(
        { label: options.label, error: message },
        'Rate-limit Redis unavailable — failing closed'
      );
      reply.status(503).send({ error: 'rate_limit_unavailable' });
      return true;
    }
  };
}
