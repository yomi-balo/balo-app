import type { FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@balo/shared/logging';
import { getRedis } from './redis.js';
import { checkRateLimit, RATE_LIMIT_DEADLINE_MS, type RateLimitConfig } from './rate-limiter.js';
import { withDeadline } from './with-deadline.js';

const log = createLogger('rate-limit-prehandler');

/**
 * The verbatim `msg` of the 429 hit log below. Exported (BAL-461) so the standalone
 * `POST /rate-limit/check` route (`routes/rate-limit/index.ts`) logs the identical string for
 * ITS OWN refusals rather than a second hand-typed copy that could drift from this one.
 */
export const RATE_LIMIT_EXCEEDED_LOG_MESSAGE = 'Rate limit exceeded';

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
 *
 * BAL-461 extracted this file's refusal-log gate (`shouldLogRateLimitRefusal`) and its 429 wire
 * reply (`sendRateLimitedReply`) into named exports below. Both now have a second caller — the
 * standalone `POST /rate-limit/check` route (`routes/rate-limit/index.ts`) — so the modulo
 * re-arm and the `Retry-After` + `{error:'rate_limited', cooldownSeconds}` shape have exactly
 * one definition instead of a second hand-copy that could silently drift from this one.
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
        // BAL-519 (SEC1) — log the 1st, then every `maxRequests`-th, refusal per bucket window
        // (the 61st, 121st, … at the default 60). Logging every refusal would let a flood against
        // the two PUBLIC IP-keyed callers (`/experts/search`, the availability route) amplify
        // itself into an equal-volume Axiom ingest — the control paying for the abuse it exists
        // to record. Volume remains visible in Fastify's own request log; this line supplies the
        // who/which-bucket. `identifier` is present ONLY under `logIdentifier` — see the option's
        // docblock.
        //
        // ⚠ Deliberately a MODULO RE-ARM, not `current === maxRequests + 1`: `withDeadline` bounds
        // the WAIT, not the work, so if the request whose INCR lands `maxRequests + 1` loses its
        // result to the deadline (or a post-send Redis error), the INCR still lands and the catch
        // below runs without ever observing that value — under a bare equality gate the ENTIRE
        // window would then log nothing. The re-arm bounds that silence to at most `maxRequests`
        // further refusals while keeping the amplification cap at ~1/`maxRequests`. `current` is
        // monotonic per window (Redis serializes the MULTIs), so each re-arm value is observed by
        // at most one request.
        if (shouldLogRateLimitRefusal(result.current, options.config.maxRequests)) {
          log.warn(
            {
              label: options.label,
              keyPrefix: options.config.keyPrefix,
              current: result.current,
              ttlSeconds: result.ttlSeconds,
              ...(options.logIdentifier === true ? { identifier } : {}),
            },
            RATE_LIMIT_EXCEEDED_LOG_MESSAGE
          );
        }
        sendRateLimitedReply(reply, result.ttlSeconds, options.config.windowSeconds);
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

/**
 * BAL-519's log-gate predicate, pulled out to a standalone export so a second call site —
 * `routes/rate-limit/index.ts` — can gate its own refusal log the same way, without a second
 * hand-copy of the modulo re-arm to keep in sync.
 *
 * Safe to call on its own, outside the `!result.allowed` branch above: `current > maxRequests`
 * is the same condition as `!result.allowed` (`rate-limiter.ts`'s `allowed: current <=
 * config.maxRequests`), so this function re-asserts it rather than assuming a caller already
 * checked. Returns `true` on the FIRST refusal past the limit, then again every `maxRequests`
 * refusals after that (the 61st, 121st, … at `maxRequests` 60) — see the modulo-re-arm
 * rationale at the call site above.
 */
export function shouldLogRateLimitRefusal(current: number, maxRequests: number): boolean {
  return current > maxRequests && (current - maxRequests - 1) % maxRequests === 0;
}

/**
 * The house 429 wire reply (BAL-461): a `Retry-After` header plus
 * `{ error: 'rate_limited', cooldownSeconds }`, shared by this file's own preHandler and the
 * standalone `POST /rate-limit/check` route so the two 429 paths cannot drift into two subtly
 * different shapes.
 *
 * `cooldownSeconds` passes `ttlSeconds` through UNCHANGED whenever it is `0` or positive, and
 * falls back to `windowSeconds` only when it is negative. Redis's `TTL` rounds to the nearest
 * second, so `0` is an ordinary value in the last <500 ms of any window — on every Redis
 * version — and every existing caller of this file's preHandler (expert search, availability,
 * session statements, brief-parse) has always sent `Retry-After: 0` in that moment; treating `0`
 * as "no expiry" would silently turn that into a full-window wait. `-1` is the actual "no
 * expiry" signal — `checkRateLimit` never checks the `EXPIRE NX` result (`rate-limiter.ts`,
 * tracked separately) — and it exists only so neither caller ever tells a refused caller to
 * retry a negative number of seconds from now.
 */
export function sendRateLimitedReply(
  reply: FastifyReply,
  ttlSeconds: number,
  windowSeconds: number
): void {
  const cooldownSeconds = ttlSeconds >= 0 ? ttlSeconds : windowSeconds;
  reply
    .header('Retry-After', String(cooldownSeconds))
    .status(429)
    .send({ error: 'rate_limited', cooldownSeconds });
}
