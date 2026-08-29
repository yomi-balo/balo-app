/**
 * BAL-409 — shared booking-path guards, EXTRACTED from `routes/meetings/index.ts` so the
 * booking route and the new reschedule route (`reschedule.ts`) share ONE copy of each. A second
 * copy of any of these is a guaranteed jscpd hit, and — worse — a second place for the rate
 * limit numbers or the fail-closed posture to drift.
 *
 * Behaviour is UNCHANGED from what `routes/meetings/index.ts` shipped before this extraction;
 * `enforceExpertScopedGuards` gains one new optional parameter, `excludeMeeting`, threaded
 * straight through to `isWindowAvailableForExpert` (BAL-409 D7) and inert when omitted.
 */
import type { BookingWindowViolation } from '@balo/shared/meetings';
import { createLogger } from '@balo/shared/logging';
import type { FastifyReply } from 'fastify';
import {
  checkRateLimit,
  RATE_LIMIT_DEADLINE_MS,
  type RateLimitConfig,
} from '../../lib/rate-limiter.js';
import { getRedis } from '../../lib/redis.js';
import { withDeadline } from '../../lib/with-deadline.js';
import {
  isWindowAvailableForExpert,
  type ExcludeMeetingWindow,
} from '../../services/availability/window-availability.js';

const log = createLogger('meetings-route-guards');

/**
 * PRODUCT NUMBERS, not physical limits — the same status as `@balo/shared/meetings`'s window
 * bounds, and a natural early migration when `platform_config` (BAL-398) lands.
 *
 * The per-user cap bounds one actor's total booking attempts. The per-pair cap is the tighter
 * and more important of the two: combined with availability validation it is what stops a
 * single actor walking one expert's published calendar, and no legitimate client books ten
 * meetings with the same expert inside an hour.
 */
export const BOOKING_USER_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meetings:user',
  maxRequests: 30,
  windowSeconds: 3600,
};

export const BOOKING_EXPERT_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meetings:user-expert',
  maxRequests: 10,
  windowSeconds: 3600,
};

/**
 * BAL-409 — the reschedule route's PER-USER limit. A SEPARATE bucket from
 * `BOOKING_USER_RATE_LIMIT`: rescheduling and booking are different actions with different
 * abuse shapes (a reschedule never books a NEW slot), so they should not share one counter.
 *
 * ⚠ The PER-PAIR limit on a reschedule REUSES `BOOKING_EXPERT_RATE_LIMIT` — booking and
 * rescheduling consume the same scarce thing (one expert's published calendar), so they belong
 * in one bucket. See `reschedule.ts`.
 */
export const RESCHEDULE_USER_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meetings:reschedule:user',
  maxRequests: 20,
  windowSeconds: 3600,
};

/**
 * BAL-410 — the CANCEL route's PER-USER limit.
 *
 * ⚠ ITS OWN BUCKET, NOT SHARED WITH RESCHEDULE — the same reasoning the split above gives for
 * separating reschedule from booking. Cancelling and moving are different acts with different
 * abuse profiles, and a shared counter lets one exhaust the other: a client who has just
 * rescheduled twenty times would be unable to cancel at all.
 *
 * ⚠ THERE IS DELIBERATELY NO EXPERT-SCOPED SECOND LIMIT. `enforceExpertScopedGuards` exists to
 * protect one expert's published calendar from being walked by a caller consuming slots; a
 * cancel CONSUMES nothing, performs no vendor free/busy round-trip, and only ever FREES a slot.
 * There is nothing scarce for a per-pair bucket to protect.
 */
export const CANCEL_USER_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meetings:cancel:user',
  maxRequests: 20,
  windowSeconds: 3600,
};

/**
 * BAL-411 — the reschedule-PROPOSAL route's PER-USER limit. A SEPARATE, TIGHTER bucket from
 * `RESCHEDULE_USER_RATE_LIMIT`: proposing performs up to `RESCHEDULE_PROPOSAL_MAX_OPTIONS`
 * vendor free/busy round-trips per request (one per option, via `isWindowAvailableForExpert`),
 * so it is a heavier write than an ordinary reschedule and gets its own, lower ceiling.
 */
export const RESCHEDULE_PROPOSAL_USER_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meetings:reschedule-proposal:user',
  maxRequests: 10,
  windowSeconds: 3600,
};

/**
 * Booking-window violation → the STABLE wire code. Deliberately a lookup rather than the
 * violation string itself: `invalid_window` reads better to a client than
 * `end_before_start`, and decoupling the two means the internal names can change without a
 * breaking API change.
 *
 * `invalid_instant` folds into `invalid_window`: from the client's side "you sent a window I
 * cannot interpret" and "you sent an inverted window" are the same defect, and splitting them
 * would publish an internal guard as an API contract.
 */
export const WINDOW_VIOLATION_CODE: Record<BookingWindowViolation, string> = {
  invalid_instant: 'invalid_window',
  end_before_start: 'invalid_window',
  start_not_future: 'start_must_be_future',
  duration_below_minimum: 'duration_below_minimum',
  duration_above_maximum: 'duration_above_maximum',
  start_beyond_horizon: 'beyond_booking_horizon',
};

/**
 * Consume one token from `config`'s window for `identifier`. Returns `true` when the reply has
 * ALREADY BEEN SENT and the caller must return immediately.
 *
 * ⚠ FAILS CLOSED. A Redis error answers `503`, never "carry on unlimited" — this is a write
 * path that blocks a marketplace expert's calendar, so an outage must not become an
 * unmetered booking window. `routes/experts/search.ts` fails OPEN on purpose and documents
 * why; do not copy that decision here.
 *
 * ⚠⚠ THE DEADLINE IS LOAD-BEARING, not a tidy-up. `maxRetriesPerRequest: null` (required by
 * BullMQ) stops ioredis ever failing a pending command, and the offline queue parks it — so
 * an unbounded `checkRateLimit` NEVER SETTLES during an outage and this `catch` never runs.
 * The request would then hang on a Fastify connection until an upstream proxy killed it,
 * instead of answering the `503` below. Same exposure and same fix as the guest-invite
 * limiter in `guests.ts`. See `with-deadline.ts` for the verified ioredis mechanism.
 */
export async function enforceBookingRateLimit(
  config: RateLimitConfig,
  identifier: string,
  reply: FastifyReply
): Promise<boolean> {
  try {
    const result = await withDeadline(() => checkRateLimit(getRedis(), config, identifier), {
      deadlineMs: RATE_LIMIT_DEADLINE_MS,
      label: `rate limit ${config.keyPrefix}`,
    });
    if (result.allowed) {
      return false;
    }
    log.warn({ identifier, keyPrefix: config.keyPrefix }, 'Meeting booking rate-limited');
    reply
      .header('Retry-After', String(result.ttlSeconds))
      .code(429)
      .send({ error: 'rate_limited', cooldownSeconds: result.ttlSeconds });
    return true;
  } catch (error) {
    log.error(
      {
        keyPrefix: config.keyPrefix,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Meeting booking rate-limit unavailable — failing CLOSED'
    );
    reply.code(503).send({ error: 'rate_limit_unavailable' });
    return true;
  }
}

/**
 * The two guards that need the expert the gate resolved: the per-pair rate limit and the
 * real-availability check. Returns `true` when the reply has already been sent.
 *
 * ⚠ A `409` WITH A FIXED LITERAL, NEVER AN `err.message` ECHO AND NEVER A REASON. "Not
 * available" is all a client is told: enumerating WHY (outside published hours / already
 * booked / inside a time-off block / below minimum notice) would turn this route into a
 * free-busy oracle over an expert's private calendar for anyone holding one context id.
 *
 * `excludeMeeting` (BAL-409, optional) — threaded straight to `isWindowAvailableForExpert` so a
 * reschedule of meeting M does not collide with M's own booking. Omitted (the booking route's
 * call), this is byte-identical to the pre-BAL-409 behaviour.
 */
export async function enforceExpertScopedGuards(
  params: {
    userId: string;
    expertProfileId: string;
    scheduledStart: Date;
    scheduledEnd: Date;
    excludeMeeting?: ExcludeMeetingWindow;
  },
  reply: FastifyReply
): Promise<boolean> {
  const { userId, expertProfileId, scheduledStart, scheduledEnd, excludeMeeting } = params;

  if (
    await enforceBookingRateLimit(BOOKING_EXPERT_RATE_LIMIT, `${userId}:${expertProfileId}`, reply)
  ) {
    return true;
  }

  const available = await isWindowAvailableForExpert(
    expertProfileId,
    scheduledStart,
    scheduledEnd,
    new Date(),
    excludeMeeting
  );
  if (!available) {
    log.info(
      { userId, expertProfileId },
      'Meeting booking refused — window outside the expert’s published availability or already busy'
    );
    reply.code(409).send({ error: 'window_not_available' });
    return true;
  }
  return false;
}
