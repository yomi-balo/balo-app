/**
 * BAL-134 (§7.1) — `GET /meetings/:meetingId/state`. The polled mirror feed.
 *
 * ⚠⚠ ITS RATE LIMIT FAILS **OPEN**, DELIBERATELY THE OPPOSITE OF `POST /meetings` AND
 * `POST /meetings/:id/end`. Those two WRITE — one commits a booking and blocks a marketplace
 * expert's calendar, the other terminates a money-bearing record — so an unmetered write path
 * during a Redis outage is exactly the window an attacker waits for, and a `503` is right. THIS
 * one is a READ that a browser polls every ten seconds DURING A LIVE CALL: failing it closed
 * would freeze every participant's mirror the moment Redis hiccuped, on a surface whose whole
 * job is to show what is happening. `routes/experts/search.ts` takes the same posture and says
 * so; this is that posture applied to an authenticated read.
 *
 * ⚠ THE LIMIT IS PER USER, NOT PER IP. Every request arrives through `apps/web`'s server-side
 * fetch, so an IP key would put the whole platform's in-call polling in one bucket — the same
 * mistake `join.ts` records for the guest poll, where three concurrent guests would exhaust a
 * 600/hour window on their own.
 *
 * ⚠ THE PAYLOAD CARRIES NO MONEY FIGURE, NO TOKEN, NO `roomUrl` AND NO `participantId` — see
 * `services/meetings/meeting-state.ts`.
 */
import { createLogger } from '@balo/shared/logging';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkRateLimit, type RateLimitConfig } from '../../lib/rate-limiter.js';
import { getRedis } from '../../lib/redis.js';
import { requireAuth } from '../../lib/require-auth.js';
import { resolveUserId } from '../../lib/route-helpers.js';
import { resolveMeetingTimers } from '../../config/meeting-timers.js';
import { getMeetingState } from '../../services/meetings/meeting-state.js';
import { meetingIdParamsSchema } from './join.schema.js';

const log = createLogger('meeting-state-route');

/**
 * PRODUCT NUMBERS, not physical limits — the same status as the booking and join limits, and a
 * natural early migration when `platform_config` (BAL-398) lands.
 *
 * ⚠ SIZED FOR A REAL CALL. The poll runs at 10s while non-terminal, i.e. ~360 requests/hour per
 * participant per meeting; 1 200 covers a participant in three concurrent long calls with
 * headroom, and still bounds a scanner. It exists to bound SCANNING, not to bound watching.
 */
const STATE_POLL_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meeting-state:user',
  maxRequests: 1_200,
  windowSeconds: 3600,
};

/**
 * Consume one token. Returns `true` when the reply has ALREADY been sent.
 *
 * ⚠ FAILS OPEN — see the module docblock. A Redis error logs at `warn` (the RATE is the health
 * signal) and the request proceeds.
 */
async function enforceStatePollLimit(userId: string, reply: FastifyReply): Promise<boolean> {
  try {
    const result = await checkRateLimit(getRedis(), STATE_POLL_RATE_LIMIT, userId);
    if (result.allowed) {
      return false;
    }
    reply
      .header('Retry-After', String(result.ttlSeconds))
      .code(429)
      .send({ error: 'rate_limited', cooldownSeconds: result.ttlSeconds });
    return true;
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Meeting-state rate limit unavailable — failing OPEN (a read path during a live call)'
    );
    return false;
  }
}

export async function meetingStateRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/meetings/:meetingId/state',
    { preHandler: [requireAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = resolveUserId(req, reply);
      if (userId === null) return;

      const params = meetingIdParamsSchema.safeParse(req.params);
      if (!params.success) {
        reply.code(400).send({ error: 'invalid_request' });
        return;
      }

      if (await enforceStatePollLimit(userId, reply)) return;

      const result = await getMeetingState({
        meetingId: params.data.meetingId,
        userId,
        // ⚠ THE ENV-RESOLVED TIMERS (D8). Resolved per request rather than at module load so a
        // configuration change takes effect on a redeploy without a code change, and so merely
        // importing this route is not environment-dependent.
        timers: resolveMeetingTimers(),
      });

      if (!result.ok) {
        // ⚠ 404 FOR EVERY DENIAL. The gate already logged the shape.
        reply.code(404).send({ error: result.code });
        return;
      }
      reply.code(200).send(result.state);
    }
  );

  log.info('Registered meeting state route');
}
