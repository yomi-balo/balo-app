import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createLogger } from '@balo/shared/logging';
import {
  RATE_LIMIT_BUCKETS,
  RATE_LIMIT_CHECK_PATH,
  RATE_LIMIT_CHECK_DEADLINE_MS,
  createLogGate,
} from '@balo/shared/rate-limit';
import { requireInternalAuth } from '../../lib/internal-auth.js';
import { parseBodyOr400 } from '../../lib/route-helpers.js';
import { getRedis } from '../../lib/redis.js';
import { checkRateLimit } from '../../lib/rate-limiter.js';
import { withDeadline } from '../../lib/with-deadline.js';
import {
  shouldLogRateLimitRefusal,
  sendRateLimitedReply,
  RATE_LIMIT_EXCEEDED_LOG_MESSAGE,
} from '../../lib/rate-limit-prehandler.js';
import { WEB_RATE_LIMIT_BUCKET_CONFIGS } from './buckets.js';

const log = createLogger('web-rate-limit');

/**
 * The verbatim `msg` of the Redis-unavailable line below, exported so `index.test.ts` pins it
 * against the exact literal rather than a substring.
 */
export const RATE_LIMIT_REDIS_UNAVAILABLE_LOG_MESSAGE =
  'Rate-limit Redis unavailable — answering 503';

/**
 * The verbatim `msg` for a rejected (401) request to this route, exported for the same reason.
 */
export const RATE_LIMIT_UNAUTHORIZED_LOG_MESSAGE = 'Unauthorized rate-limit check request';

const checkBodySchema = z
  .object({
    bucket: z.enum(RATE_LIMIT_BUCKETS),
    userId: z.uuid(),
  })
  .strict();

/**
 * BAL-461 — `POST /rate-limit/check`, the shared counter behind `apps/web`'s
 * `checkSharedRateLimit`. This is the only place in the codebase that runs `checkRateLimit`
 * against a bucket the web tier chose; every other caller of that function picks its own
 * bucket for its own route.
 *
 * Secret-gated, not user-authed: `requireInternalAuth` costs no DB read, unlike the Bearer path,
 * and it still works under impersonation, where an impersonated session carries no WorkOS token
 * at all. The web tier has already authenticated the session by the time it calls here; this
 * route trusts the `userId` it is handed, the same trust model as `/notifications/publish` and
 * `/credit/purchase-intent`. Auth runs as an `onRequest` hook, before the body is parsed, so a
 * request with the wrong key never pays for reading its own body — see `bodyLimit` below.
 *
 * `logLevel: 'warn'` drops Fastify's own per-request "incoming request"/"request completed" info
 * lines for this route only (`app.test.ts` pins this against a `GET /health` control that still
 * writes them) — this route can see up to ~120 calls a minute from one active user, and doubling
 * that into request-log volume would defeat the point of gating the refusal log below. `warn`
 * and `error` lines (the refusal log, the unauthorized-request log, the Redis-down log, and a
 * genuine 5xx) are unaffected. Because that suppression also removes the ordinary trace of a
 * failed secret, a gated `onResponse` hook writes one warn line a minute while wrong-key
 * requests keep arriving, so probing the secret against this route does not go unseen.
 *
 * `bodyLimit: 1024` bounds the body Fastify will read for an AUTHENTICATED caller only — the
 * real payload is two short fields, so a request that clears `onRequest` auth and still exceeds
 * this is a caller bug, not probing. An unauthenticated request never has its body buffered or
 * parsed at all, because auth runs in `onRequest`, before parsing; Node still drains the unread
 * bytes off the socket regardless of this setting, so `bodyLimit` is not what protects against a
 * large body from an unauthenticated caller.
 *
 * This route only counts. It grants nothing and never mutates state, so a leaked
 * `INTERNAL_API_SECRET` (already required to exhaust the same secret's other routes) lets an
 * attacker exhaust another user's bucket, not spend their credit or read their data.
 *
 * Redis health, not just reachability: `getRedis()` shares its connection with BullMQ and is
 * created with `maxRetriesPerRequest: null` plus its default offline queue, so a command issued
 * while the client is reconnecting (not yet ended or errored) would be parked rather than
 * rejected, and would replay against Redis once it reconnects — a stale INCR replayed minutes
 * later would corrupt a future window's count. Checking `redis.status !== 'ready'` inside the
 * deadline-bound thunk turns that parked-then-replayed command into an immediate, gated 503
 * instead, the same fail-closed answer as any other Redis error here. One documented residual
 * survives this: a command already flushed to a half-open socket right before the status flips
 * can still be resent by ioredis on reconnect; this route does not attempt to de-duplicate that
 * resend.
 *
 * Failing open is a web-side policy, not this route's: a Redis error or deadline here always
 * answers `503 rate_limit_unavailable`. `apps/web`'s `checkSharedRateLimit` is what fails open
 * today; a future fail-closed consumer could call this same route unchanged.
 *
 * Both log gates below are created inside this function rather than at module scope, so every
 * `buildApp()` call gets its own fresh gates instead of sharing suppression state with any other
 * app instance built in the same process.
 */
export async function rateLimitRoutes(fastify: FastifyInstance): Promise<void> {
  const redisDownLogGate = createLogGate(60_000);
  const unauthorizedLogGate = createLogGate(60_000);

  fastify.post(
    RATE_LIMIT_CHECK_PATH,
    {
      onRequest: [requireInternalAuth],
      onResponse: async (_request, reply) => {
        if (reply.statusCode !== 401) return;
        const { admitted, suppressed } = unauthorizedLogGate.admit(Date.now());
        if (admitted) {
          log.warn({ suppressed }, RATE_LIMIT_UNAUTHORIZED_LOG_MESSAGE);
        }
      },
      bodyLimit: 1024,
      // The app's global error handler (`app.ts`) always answers a caught error with a plain
      // 500, which would otherwise turn Fastify's own body-too-large error into a 500 instead
      // of the 413 it already carries. This route-level handler intercepts only that one case
      // and re-throws everything else, so any other failure here still goes through the app's
      // usual Sentry capture and logging unchanged.
      errorHandler: (error, _request, reply) => {
        if (error.statusCode === 413) {
          reply.status(413).send({ error: 'payload_too_large' });
          return;
        }
        throw error;
      },
      logLevel: 'warn',
    },
    async (request, reply) => {
      const body = parseBodyOr400(checkBodySchema, request, reply);
      if (body === null) return;

      const { bucket, userId } = body;
      // The closed enum on `checkBodySchema` means this lookup can never miss.
      const config = WEB_RATE_LIMIT_BUCKET_CONFIGS[bucket];

      try {
        const result = await withDeadline(
          () => {
            const redis = getRedis();
            if (redis.status !== 'ready') {
              // Gated 503 below, exactly as a thrown Redis command error is — see this
              // function's docblock for why a merely-reconnecting client must not be allowed to
              // park (and later replay) a command here.
              throw new Error(`Redis not ready (status: ${redis.status})`);
            }
            return checkRateLimit(redis, config, userId);
          },
          { deadlineMs: RATE_LIMIT_CHECK_DEADLINE_MS, label: `rate limit ${config.keyPrefix}` }
        );

        if (!result.allowed) {
          if (shouldLogRateLimitRefusal(result.current, config.maxRequests)) {
            log.warn(
              {
                label: 'web-rate-limit',
                bucket,
                keyPrefix: config.keyPrefix,
                current: result.current,
                ttlSeconds: result.ttlSeconds,
                userId,
              },
              RATE_LIMIT_EXCEEDED_LOG_MESSAGE
            );
          }
          sendRateLimitedReply(reply, result.ttlSeconds, config.windowSeconds);
          return;
        }

        reply.send({ allowed: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const { admitted, suppressed } = redisDownLogGate.admit(Date.now());
        if (admitted) {
          log.warn(
            { bucket, error: message, suppressed },
            RATE_LIMIT_REDIS_UNAVAILABLE_LOG_MESSAGE
          );
        }
        reply.status(503).send({ error: 'rate_limit_unavailable' });
      }
    }
  );
}
