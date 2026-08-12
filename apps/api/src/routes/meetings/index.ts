/**
 * BAL-129 — `POST /meetings`: the FIRST Fastify route that writes `meeting_contexts`, and
 * therefore the first surface carrying the tenancy obligation
 * `schema/meeting-contexts.ts` assigns to this ticket by name.
 *
 * ⚠ A FASTIFY ROUTE, NOT AN `apps/web` SERVER ACTION, and that is not a style preference.
 * The availability-cache rebuild runs on a BullMQ queue that exists only in `apps/api`, and
 * `@balo/db` cannot reach a queue (the `repositories-never-notify` invariant, plus the
 * `@balo/db`-in-a-client-bundle footgun). A web action calling `create` directly "would
 * commit a booking and leave every expert-facing surface advertising a slot that is already
 * taken" (`services/meetings/meeting-availability.ts`).
 *
 * ── SEQUENCE ────────────────────────────────────────────────────────────────
 *   requireAuth → resolveUserId (401, defensive)
 *     → per-USER rate limit                     → 429 / 503 (fail-CLOSED)
 *     → createMeetingBodySchema.safeParse       → 400 invalid_request
 *     → validateBookingWindow(start, end, now)  → 400 <stable code>
 *     → authorizeMeetingBooking(...)            → 404 / 400
 *     → per-(USER, EXPERT) rate limit           → 429 / 503 (fail-CLOSED)
 *     → isWindowAvailableForExpert(...)         → 409 window_not_available
 *     → bookAndProvisionMeeting(...)            → 201
 *        └── typed errors → mapped statuses
 *
 * The cheap, leak-free checks run first on purpose: a malformed window must not cost a
 * database round-trip, and a 400 that leaks nothing is a better answer to a probe than a 404
 * that confirms a uuid. The per-user limit precedes even the body parse so a flood of garbage
 * is bounded too; the per-pair limit and the availability read cannot run before the gate,
 * because both need the `expertProfileId` the gate resolves.
 *
 * ── WHY THERE ARE THREE VOLUME CONTROLS AND NOT ONE (BAL-129 §2) ────────────
 *
 * ⚠ THE TENANCY GATE IS NOT A VOLUME CONTROL, AND `@balo/shared/meetings`'s CONSTANTS ARE
 * PER-WINDOW ONLY. The gate closes booking on a calendar the actor cannot reach; the constants
 * cap one window's duration and horizon. Neither bounds how MANY windows a legitimate member
 * may place, and the un-bounded version of this route accepted ~1,095 consecutive 8-hour
 * bookings — a year of any reachable expert's calendar — plus any number of mutually
 * OVERLAPPING ones. Both matter most for `project_kickoff` / `project_discovery`, which carry
 * NO credit hold, so nothing charges for the slot either. Hence:
 *
 * ⚠ AND THE THREE TOGETHER **BOUND** THE ABUSE — THEY DO NOT CLOSE IT. Say it that way, because
 * on this branch a consumed slot stays consumed: `cancelMeeting` / `softDeleteMeeting` have
 * ZERO production callers (tests only), so no shipped surface frees a slot again (BAL-410's),
 * and NOTHING publishes `booking.confirmed` — the rule and templates in
 * `notifications/engine/rules.ts` are a documented orphan (BAL-400's) — so the expert is never
 * told their calendar is filling up. Inside the limits, bookings here are IRREVERSIBLE and
 * SILENT. That is the residual these three controls hold to a slow walk rather than eliminate.
 *
 *   1. AVAILABILITY VALIDATION (`isWindowAvailableForExpert`) — the load-bearing one. The
 *      window must lie wholly inside availability the expert PUBLISHED and be free of every
 *      confirmed consultation, so a caller can only consume slots the expert chose to offer,
 *      each success removes one, and overlaps are refused.
 *   2. A PER-USER rate limit — bounds total booking attempts by one actor.
 *   3. A PER-(USER, EXPERT) rate limit — bounds how fast ONE actor can walk ONE expert's
 *      published calendar, which (1) alone does not.
 *
 * ⚠ BOTH LIMITS FAIL **CLOSED** ON A REDIS ERROR — unlike `routes/experts/search.ts`, which
 * fails OPEN and says so. That endpoint is a public read-only search where availability
 * outranks strict limiting. This one WRITES: it commits a booking and blocks a marketplace
 * expert's calendar. An unlimited write path during a Redis outage is exactly the window an
 * attacker waits for, so a 503 is the correct answer.
 *
 * ── THIS ROUTE IS THE `log.error` BOUNDARY ──────────────────────────────────
 *
 * CLAUDE.md: log where an error becomes a user-facing message. Every mapped branch logs the
 * full message and stack SERVER-SIDE and sends only a FIXED LITERAL.
 *
 * ⚠ NEVER ECHO `err.message` FROM THE TYPED ERRORS. They embed raw uuids (engagement ids,
 * project-request ids, expert-profile ids) to make the SERVER log actionable;
 * `meeting-availability.ts` explicitly forbids passing them to the client.
 *
 * Four notes a reviewer will otherwise read as misses:
 *
 *   · THERE IS NO `403` ON THIS ROUTE. The gate collapses "no such context" and "not a member
 *     of the company that owns it" into ONE `404 context_not_found`, matching
 *     `sessionActorErrorStatus`'s `not_found → 404` "(also hides existence)" and
 *     `meeting_not_bookable`'s six-shapes-one-literal precedent. The full argument, and why
 *     `context_type_mismatch` may still be distinct, is in `authorize-meeting-booking.ts`.
 *
 *   · `MeetingContextUnresolvableError` REUSES `context_not_found` ON PURPOSE. After the gate
 *     has already resolved the row, this error means the subject was soft-deleted between the
 *     gate read and the write — a TOCTOU race. Same fact, same literal, no extra information
 *     handed to a prober.
 *
 *   · `MeetingContextRequiredError` IS DELIBERATELY LEFT UNMAPPED → 500. The route always
 *     passes exactly one context, so it is structurally unreachable. Mapping it would be dead
 *     code that SonarCloud counts as uncovered changed lines, and if it ever DOES fire it
 *     means the route's own construction broke — a Sentry-captured 500 is the correct signal.
 *
 *   · A `DailyConfigError` / `DailyApiError` IS NOT AN ERROR RESPONSE AT ALL. The booking has
 *     already committed, so it returns `201` with `provisioned: false` (see
 *     `provision-meeting.ts`). `MeetingNotCancellableError` / `MeetingNotReschedulableError`
 *     cannot arise from a booking and are BAL-409/BAL-410/BAL-411's to map.
 */
import {
  MatchModeDiscoveryNotBookableError,
  MeetingContextNotProjectableError,
  MeetingContextUnresolvableError,
  MeetingExpertAmbiguousError,
} from '@balo/db';
import { validateBookingWindow, type BookingWindowViolation } from '@balo/shared/meetings';
import { createLogger } from '@balo/shared/logging';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  checkRateLimit,
  RATE_LIMIT_DEADLINE_MS,
  type RateLimitConfig,
} from '../../lib/rate-limiter.js';
import { getRedis } from '../../lib/redis.js';
import { requireAuth } from '../../lib/require-auth.js';
import { withDeadline } from '../../lib/with-deadline.js';
import { parseBodyOr400, resolveUserId } from '../../lib/route-helpers.js';
import { isWindowAvailableForExpert } from '../../services/availability/window-availability.js';
import { authorizeMeetingBooking } from '../../services/meetings/authorize-meeting-booking.js';
import {
  bookAndProvisionMeeting,
  type BookAndProvisionInput,
} from '../../services/meetings/provision-meeting.js';
import { createMeetingBodySchema } from './schema.js';
import { meetingGuestRoutes } from './guests.js';
import { meetingJoinRoutes } from './join.js';

const log = createLogger('meetings-route');

/**
 * PRODUCT NUMBERS, not physical limits — the same status as `@balo/shared/meetings`'s window
 * bounds, and a natural early migration when `platform_config` (BAL-398) lands.
 *
 * The per-user cap bounds one actor's total booking attempts. The per-pair cap is the tighter
 * and more important of the two: combined with availability validation it is what stops a
 * single actor walking one expert's published calendar, and no legitimate client books ten
 * meetings with the same expert inside an hour.
 */
const BOOKING_USER_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meetings:user',
  maxRequests: 30,
  windowSeconds: 3600,
};

const BOOKING_EXPERT_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:meetings:user-expert',
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
const WINDOW_VIOLATION_CODE: Record<BookingWindowViolation, string> = {
  invalid_instant: 'invalid_window',
  end_before_start: 'invalid_window',
  start_not_future: 'start_must_be_future',
  duration_below_minimum: 'duration_below_minimum',
  duration_above_maximum: 'duration_above_maximum',
  start_beyond_horizon: 'beyond_booking_horizon',
};

/**
 * The gate's outcome → HTTP status. Two entries, not three: see the module docblock on why
 * there is no `forbidden`.
 */
const GATE_ERROR_STATUS = {
  context_not_found: 404,
  context_type_mismatch: 400,
} as const;

/**
 * A thrown booking error → `{ status, error }`, or `null` for "unhandled, let it 500".
 * Every literal here is FIXED — none is derived from `error.message`.
 */
function bookingErrorResponse(error: unknown): { status: number; error: string } | null {
  if (error instanceof MeetingContextUnresolvableError) {
    return { status: 404, error: 'context_not_found' };
  }
  if (error instanceof MatchModeDiscoveryNotBookableError) {
    return { status: 409, error: 'discovery_not_routed' };
  }
  if (error instanceof MeetingExpertAmbiguousError) {
    return { status: 409, error: 'meeting_expert_ambiguous' };
  }
  if (error instanceof MeetingContextNotProjectableError) {
    return { status: 409, error: 'context_not_bookable' };
  }
  return null;
}

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
async function enforceBookingRateLimit(
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
 */
async function enforceExpertScopedGuards(
  params: {
    userId: string;
    expertProfileId: string;
    scheduledStart: Date;
    scheduledEnd: Date;
  },
  reply: FastifyReply
): Promise<boolean> {
  const { userId, expertProfileId, scheduledStart, scheduledEnd } = params;

  if (
    await enforceBookingRateLimit(BOOKING_EXPERT_RATE_LIMIT, `${userId}:${expertProfileId}`, reply)
  ) {
    return true;
  }

  const available = await isWindowAvailableForExpert(
    expertProfileId,
    scheduledStart,
    scheduledEnd,
    new Date()
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

/**
 * EVERY PRE-BOOKING GUARD, IN ORDER — returns the validated service input, or `null` when a
 * reply has already been sent (the caller must return immediately).
 *
 * ⚠ EXTRACTED FROM THE HANDLER, NOT MERELY TIDIED. Six sequential guards plus the try/catch
 * put the handler over SonarCloud's cognitive-complexity ceiling of 15, and "add one more
 * guard" is exactly what the next reschedule/cancel route will want to do. Keeping the
 * validation pipeline in one named function means the handler stays a two-step read (validate,
 * then book) and the ORDER of the guards — which is load-bearing, see the module docblock — is
 * legible in one place.
 */
async function resolveBookingInput(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string
): Promise<BookAndProvisionInput | null> {
  if (await enforceBookingRateLimit(BOOKING_USER_RATE_LIMIT, userId, reply)) return null;

  // Zod messages carry no server-side uuid, so echoing `details` is house style and safe.
  const parsed = parseBodyOr400(createMeetingBodySchema, request, reply);
  if (parsed === null) return null;

  const { contextType, contextId } = parsed;
  const scheduledStart = new Date(parsed.scheduledStart);
  const scheduledEnd = new Date(parsed.scheduledEnd);

  const violation = validateBookingWindow(scheduledStart, scheduledEnd, new Date());
  if (violation !== null) {
    reply.code(400).send({ error: WINDOW_VIOLATION_CODE[violation] });
    return null;
  }

  const authorized = await authorizeMeetingBooking({ contextType, contextId, userId });
  if (!authorized.ok) {
    reply.code(GATE_ERROR_STATUS[authorized.code]).send({ error: authorized.code });
    return null;
  }

  // A `null` expert means a `match`-routed `project_discovery`: there is no calendar to rate
  // limit against and none to check availability on. The repository throws
  // `MatchModeDiscoveryNotBookableError`, which maps to `409 discovery_not_routed` — so this is
  // a skip, not a bypass.
  if (
    authorized.expertProfileId !== null &&
    (await enforceExpertScopedGuards(
      { userId, expertProfileId: authorized.expertProfileId, scheduledStart, scheduledEnd },
      reply
    ))
  ) {
    return null;
  }

  return {
    contextType,
    contextId,
    scheduledStart,
    scheduledEnd,
    engagementType: authorized.engagementType,
    userId,
  };
}

export async function meetingsRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /meetings — book a meeting and provision its Daily room.
  fastify.post('/meetings', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = resolveUserId(request, reply);
    if (userId === null) return;

    const input = await resolveBookingInput(request, reply, userId);
    if (input === null) return;

    try {
      const result = await bookAndProvisionMeeting(input, request.log);

      // ⚠ 201 EVEN WHEN `provisioned` IS FALSE. The booking committed and the slot is
      // blocked; the join url is a MISSING ARTEFACT, not a failure. BAL-400's UI must branch
      // on `provisioned` and render "we're setting up your call room" rather than a dead
      // join button. Returning `joinUrl` to the gated actor who just booked is safe precisely
      // because rooms are `privacy: 'private'` — the URL alone admits nobody (D8).
      reply.code(201).send({
        meetingId: result.meeting.id,
        scheduledStart: result.meeting.scheduledStart.toISOString(),
        scheduledEnd: result.meeting.scheduledEnd.toISOString(),
        provisioned: result.provisioned,
        dailyRoomName: result.dailyRoomName,
        joinUrl: result.joinUrl,
      });
    } catch (error) {
      const mapped = bookingErrorResponse(error);
      log.error(
        {
          contextType: input.contextType,
          contextId: input.contextId,
          userId,
          errorName: error instanceof Error ? error.name : 'unknown',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'Meeting booking failed'
      );
      // Unmapped ⇒ rethrow to the Fastify error handler, which captures to Sentry and 500s.
      if (mapped === null) throw error;
      reply.code(mapped.status).send({ error: mapped.error });
    }
  });

  // BAL-408 — the guest participation surface (invite / list / remove / admit / deny). A
  // sibling registration rather than a separate plugin so every `/meetings` route shares one
  // prefix and one `requireAuth` idiom.
  await meetingGuestRoutes(fastify);

  // BAL-132 — the join surface (member join / anonymous lobby claim / guest mint-or-poll).
  // ⚠ A SIBLING REGISTRATION, same reasoning as the guest routes above — one prefix, one
  // idiom. ⚠ TWO OF ITS THREE ROUTES ARE PUBLIC (no `requireAuth`) and that is deliberate;
  // see that module's docblock before "fixing" it.
  await meetingJoinRoutes(fastify);

  log.info('Registered meeting routes');
}
