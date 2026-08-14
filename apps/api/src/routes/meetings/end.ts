/**
 * BAL-134 / ADR-1049 — `POST /meetings/:meetingId/end`. The SERVER end endpoint.
 *
 * ⚠⚠ AUTHENTICATED, AND UNLIKE ITS TWO PUBLIC JOIN SIBLINGS THAT IS NOT NEGOTIABLE. Ending a
 * meeting for everyone is a mutation over a money-bearing record; a guest has no membership and
 * is not on the engagement axis, so `canEndMeeting` is false for them by construction (edge
 * case 24) and they see Leave only.
 *
 * ⚠ EVERY DENIAL IS `404 meeting_not_found`. There is NO `403` anywhere on `/meetings/*` and
 * this surface must not become the exception — the shape goes to `log.warn` inside the service.
 * The one non-404 refusal, `409 meeting_not_started`, is reachable only AFTER tenancy and end
 * authority are both proven, so it is not an existence oracle; see `end-meeting.ts` step 3b.
 *
 * ⚠ A SECOND END IS `200`, NOT `409` (D10). Two `canEndMeeting` holders can press the button
 * at the same instant, and the transition is a compare-and-set; the loser gets
 * `{ alreadyEnded: true }` with no second teardown, no second audit row and no second analytics
 * event. A `409` would surface a routine race as a user-facing error on the one control that
 * must always work.
 *
 * ── ⚠⚠ THE RATE LIMIT FAILS **CLOSED**, AND `state.ts` DOCUMENTS ITSELF AGAINST THIS ────────
 *
 * `GET /meetings/:id/state`'s docblock contrasts its own fail-OPEN posture with "`POST
 * /meetings` and `POST /meetings/:id/end`" failing closed. That claim used to be FALSE here —
 * this route had no limiter at all — and it is true now. The reasoning is the booking route's,
 * verbatim: this endpoint WRITES, and what it writes is IRREVERSIBLE (`MEETING_TRANSITIONS
 * .ended === []`, the Daily room is deleted, rejoin is refused). An unmetered destructive write
 * path during a Redis outage is precisely the window an attacker waits for.
 *
 * ⚠ IT IS ALSO NOT ONLY AN ABUSE CONTROL. Every call — INCLUDING one destined for a `404` —
 * costs a meeting read, a contexts read, an owning-party resolution, a membership read and
 * `resolveHostContext`. Un-limited, a loop over guessed uuids is a cheap way to make this
 * endpoint do five queries per request forever.
 *
 * ⚠⚠ AND `withDeadline` IS WHAT MAKES "FAILS CLOSED" TRUE RATHER THAN MERELY INTENDED.
 * `getRedis()` sets `maxRetriesPerRequest: null` (BullMQ requires it), so ioredis PARKS
 * commands in its offline queue instead of failing them — without the deadline the `catch`
 * below is unreachable during the very outage it exists for, and the request hangs on a Fastify
 * connection until an upstream proxy kills it. See `with-deadline.ts` for the verified
 * ioredis mechanism.
 */
import { createLogger } from '@balo/shared/logging';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  checkRateLimit,
  RATE_LIMIT_DEADLINE_MS,
  type RateLimitConfig,
} from '../../lib/rate-limiter.js';
import { getRedis } from '../../lib/redis.js';
import { requireAuth } from '../../lib/require-auth.js';
import { withDeadline } from '../../lib/with-deadline.js';
import { resolveUserId } from '../../lib/route-helpers.js';
import { endMeeting, type EndMeetingErrorCode } from '../../services/meetings/end-meeting.js';
import { meetingIdParamsSchema } from './join.schema.js';

const log = createLogger('meeting-end-route');

/**
 * PRODUCT NUMBERS, not physical limits — the same status as `BOOKING_USER_RATE_LIMIT`, which
 * this mirrors, and a natural early migration when `platform_config` (BAL-398) lands.
 *
 * ⚠ SIZED FOR REAL USE, WHICH IS TINY. Ending is a once-per-consultation act, and the D10
 * idempotent second end means a double-click costs one extra call rather than an error. 60/hour
 * covers a Balo staffer clearing a backlog of stuck rooms by hand and still bounds a scanner
 * walking guessed uuids.
 */
const END_USER_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meeting-end:user',
  maxRequests: 60,
  windowSeconds: 3600,
};

/**
 * Service literal → HTTP status. Exhaustive over `EndMeetingErrorCode` BY TYPE, so a new
 * literal is a compile error here rather than a silent `undefined` status (i.e. a 500).
 */
const END_ERROR_STATUS: Record<EndMeetingErrorCode, number> = {
  meeting_not_found: 404,
  meeting_not_started: 409,
};

/**
 * Consume one token. Returns `true` when the reply has ALREADY been sent.
 *
 * ⚠ FAILS CLOSED — see the module docblock. Deliberately the OPPOSITE of the sibling state
 * route, which is a read a browser polls during a live call and fails OPEN on purpose.
 */
async function enforceEndRateLimit(userId: string, reply: FastifyReply): Promise<boolean> {
  try {
    const result = await withDeadline(
      () => checkRateLimit(getRedis(), END_USER_RATE_LIMIT, userId),
      { deadlineMs: RATE_LIMIT_DEADLINE_MS, label: `rate limit ${END_USER_RATE_LIMIT.keyPrefix}` }
    );
    if (result.allowed) {
      return false;
    }
    log.warn({ userId, keyPrefix: END_USER_RATE_LIMIT.keyPrefix }, 'Meeting end rate-limited');
    reply
      .header('Retry-After', String(result.ttlSeconds))
      .code(429)
      .send({ error: 'rate_limited', cooldownSeconds: result.ttlSeconds });
    return true;
  } catch (error) {
    log.error(
      {
        keyPrefix: END_USER_RATE_LIMIT.keyPrefix,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Meeting end rate limit unavailable — failing CLOSED'
    );
    reply.code(503).send({ error: 'rate_limit_unavailable' });
    return true;
  }
}

export async function meetingEndRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/meetings/:meetingId/end', { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (userId === null) return;

    const params = meetingIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid_request' });
      return;
    }

    // ⚠ AFTER THE CHEAP PARSE, BEFORE ANY DATABASE WORK — so a malformed uuid cannot consume
    // somebody's window, and a limited request costs no queries at all.
    if (await enforceEndRateLimit(userId, reply)) return;

    const result = await endMeeting({ meetingId: params.data.meetingId, userId });
    if (!result.ok) {
      const status = END_ERROR_STATUS[result.code];
      log.warn(
        { meetingId: params.data.meetingId, userId, code: result.code, status },
        'Meeting end refused'
      );
      reply.code(status).send({ error: result.code });
      return;
    }

    reply
      .code(200)
      .send({ status: result.status, alreadyEnded: result.alreadyEnded, endedBy: result.endedBy });
  });

  log.info('Registered meeting end route');
}
