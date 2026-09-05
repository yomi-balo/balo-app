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
  /**
   * BAL-519 — WHAT TO BUCKET ON. Defaults to `request.ip`.
   *
   * ⚠ THE DEFAULT IS A CORRECTNESS CONSTRAINT, NOT A CONVENIENCE. `GET
   * /experts/:expertProfileId/availability` is DELIBERATELY public (`routes/experts/availability.ts:48-53`)
   * — it has no `requireAuth`, and this limiter is its only gate. Changing the default to anything
   * user-derived would silently unbucket that route entirely.
   *
   * ⚠ THE `undefined` → 401 RULE APPLIES ONLY TO A SUPPLIED SELECTOR, NOT TO THE DEFAULT. The
   * default path reads `request.ip` verbatim, with NO emptiness guard, so the two shipped
   * IP-keyed callers keep byte-identical behaviour for every input including a destroyed-socket
   * empty/undefined `request.ip` — a 401 from a route with no `requireAuth` at all would be both a
   * behaviour change (AC3) and semantically wrong. A SUPPLIED selector returning `string |
   * undefined` (because `request.userId` is optional by declaration, `lib/require-auth.ts:7-12`,
   * under `apps/api/tsconfig.json`'s `"strict": true`) fails closed with a `401` when it yields
   * `undefined` or `''` — see the guard in the returned handler.
   */
  identifier?: (request: FastifyRequest) => string | undefined;
  /**
   * BAL-519 — include the bucket identifier in the 429 hit log. **Default `false`.**
   *
   * ⚠ OPT-IN BECAUSE THE DEFAULT IDENTIFIER IS A RAW CLIENT IP. Logging it unconditionally would
   * newly write PII to Axiom for both existing (IP-keyed) callers, contradicting
   * `routes/experts/search.ts:24-26` (which hashes the IP specifically to avoid storing PII) and
   * `routes/meetings/join.ts:229` (which deliberately omits the identifier for its visitor/peer
   * windows). Set it `true` ONLY where the identifier is an internal user UUID — the same test
   * `meetings/guards.ts:143` and `meetings/end.ts:96` already apply when they DO log theirs.
   */
  logIdentifier?: boolean;
}

/**
 * Shared rate-limit preHandler factory. Extracted from `routes/experts/search.ts`'s
 * module-private `enforceRateLimit` (BAL-236) — a second near-identical copy for the new
 * availability route would have been a guaranteed jscpd duplication hit.
 *
 * The `Promise<boolean>` return (`true` = already answered with a 429, or a 503 when
 * `failOpen: false`) is retained because the unit tests assert on it directly
 * (`rate-limit-prehandler.test.ts`), but it is INERT in production: both callers register this as
 * a Fastify `preHandler`, and Fastify short-circuits the lifecycle as soon as the reply is sent —
 * nothing reads the value. It is not a contract a caller must honour; sending the reply is what
 * stops the request.
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
 *
 * BAL-519 added the `identifier` selector and the 429 hit log. The selector's DEFAULT
 * (`request.ip`) is load-bearing for the public availability route; the hit log's `identifier`
 * field is opt-in because the default identifier is a raw client IP.
 */
export function createRateLimitPreHandler(
  options: RateLimitPreHandlerOptions
): (request: FastifyRequest, reply: FastifyReply) => Promise<boolean> {
  const customIdentifier = options.identifier;

  return async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    let identifier: string;
    if (customIdentifier === undefined) {
      // DEFAULT PATH — byte-identical to the shipped behaviour, pathological inputs included.
      // AC3: `/experts/search` and the deliberately-public availability route must not change.
      // Do NOT add an emptiness guard here: a 401 from a route with no `requireAuth` is both a
      // behaviour change and semantically wrong.
      identifier = request.ip;
    } else {
      const selected = customIdentifier(request);
      // ⚠ FAIL CLOSED, NEVER FALL BACK. A fallback to `request.ip` would move a
      // would-be-authenticated caller into a SHARED ip bucket, and `''` would bucket every such
      // caller together so that one of them could exhaust the window for all of them. Same
      // posture and same wire shape as `resolveUserId` (`lib/route-helpers.ts:23-30`), which
      // exists for exactly this "a route was registered without the auth preHandler" case.
      // Unreachable on a route that registers `requireAuth` first — Fastify skips later hooks
      // once a reply is sent (`fastify/lib/hooks.js:407`).
      if (selected === undefined || selected.length === 0) {
        reply.code(401).send({ error: 'Unauthorized' });
        return true;
      }
      identifier = selected;
    }

    try {
      const result = await withDeadline(
        () => checkRateLimit(getRedis(), options.config, identifier),
        { deadlineMs: RATE_LIMIT_DEADLINE_MS, label: `rate limit ${options.config.keyPrefix}` }
      );
      if (!result.allowed) {
        // BAL-519 (fix round 1, SEC1) — log only the FIRST refusal per bucket per window.
        // `checkRateLimit` INCRs before comparing, so `current` is monotonic and exactly one
        // refused request per window sees `maxRequests + 1`. Logging every refusal would let a
        // flood against the two PUBLIC IP-keyed callers (`/experts/search`, the availability
        // route) amplify itself into an equal-volume Axiom ingest — the control paying for the
        // abuse it exists to record. Volume remains visible in Fastify's own request log; this
        // line supplies the who/which-bucket. `identifier` is present ONLY under `logIdentifier`
        // — see the option's docblock.
        if (result.current === options.config.maxRequests + 1) {
          log.warn(
            {
              label: options.label,
              keyPrefix: options.config.keyPrefix,
              current: result.current,
              ttlSeconds: result.ttlSeconds,
              ...(options.logIdentifier === true ? { identifier } : {}),
            },
            'Rate limit exceeded'
          );
        }
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
