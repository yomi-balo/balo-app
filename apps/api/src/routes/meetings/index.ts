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
 *     → lookupBookingReplay(key, window)        → SKIPS the two guards below on a `match`
 *     → per-(USER, EXPERT) rate limit           → 429 / 503 (fail-CLOSED)
 *     → isWindowAvailableForExpert(...)         → 409 window_not_available
 *     → bookAndProvisionMeeting(...)            → 201
 *        └── typed errors → mapped statuses
 *
 * ⚠⚠ THE REPLAY PROBE SITS **AFTER** `authorizeMeetingBooking` AND **BEFORE** THE
 * AVAILABILITY GATE, AND BOTH HALVES OF THAT PLACEMENT ARE LOAD-BEARING (BAL-400 S3/M1).
 *
 *   · AFTER the gate, always. A `bookingIdempotencyKey` is `sha256(userId:nonce)` and proves
 *     only WHO MINTED IT — never that the actor may book the submitted context. The tenancy
 *     gate is NEVER skipped, for any key, ever.
 *   · BEFORE availability, or Decision 7's replay is dead code on the exact path it exists
 *     for. A committed booking writes its own `confirmed` consultation row, which
 *     `isWindowAvailableForExpert` then reads as BUSY — so the lost-201 retry used to be
 *     answered `409 window_not_available` **about the user's own meeting**, and the client
 *     was pushed into booking a second slot.
 *
 * Only an EXACT `match` (same context AND same window — `lookupBookingReplay`) skips them; a
 * `conflict` or `none` runs every guard as before and lets the service decide. Skipping the
 * per-pair limit on a match is intentional and bounded: the per-USER limit above has already
 * been consumed by this request, and a match creates no SECOND meeting and no calendar event.
 *
 * ⚠ It does NOT follow that a match makes no outbound vendor call — an earlier version of this
 * docblock claimed "no room" and that was FALSE. `replayByIdempotencyKey` calls
 * `provisionMeeting`, which short-circuits only when BOTH venue columns are already stamped
 * (`provision-meeting.ts:279-285`); otherwise it runs `provisionVenue` and issues a live
 * `createRoom` to Daily. So a match against a meeting that committed with `provisioned: false`
 * — a state this feature ships a UI branch for — DOES hit the vendor, with the per-pair limit
 * deliberately skipped. That is still bounded and safe: the tenancy gate ran first so it is
 * never cross-tenant, the room name is deterministic so rooms cannot proliferate, and the
 * per-USER limit (30/h) still applies. It is the idempotent venue REPAIR, not a new booking.
 * Do not extend this skip to anything that is not provably repair-only.
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
 * ⚠ AND THE THREE TOGETHER **BOUND** THE ABUSE — THEY DO NOT CLOSE IT. The residual has NARROWED
 * since this paragraph was written, and the correction matters: a consumed slot is no longer
 * consumed forever. BAL-410 shipped `POST /meetings/:meetingId/cancel` (`cancel.ts`), so
 * `cancelMeeting` HAS production callers and a booked slot can be freed by the client, the
 * delivering expert or a platform admin. `softDeleteMeeting` still has no route. What remains
 * true is that a booking is SILENT to the expert until BAL-400's `booking.confirmed` publisher
 * lands, so a walk of an expert's calendar still is not announced — these three controls hold
 * that to a slow walk rather than eliminate it.
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
 *     cannot arise from a booking; each is mapped at its OWN route —
 *     `MeetingNotReschedulableError` in `reschedule.ts` (BAL-409),
 *     `MeetingNotCancellableError` in `cancel.ts` (BAL-410), both to a 409 with no message
 *     echo.
 */
import {
  MatchModeDiscoveryNotBookableError,
  MeetingContextNotProjectableError,
  MeetingContextUnresolvableError,
  MeetingExpertAmbiguousError,
} from '@balo/db';
import { validateBookingWindow } from '@balo/shared/meetings';
import { createLogger } from '@balo/shared/logging';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../../lib/require-auth.js';
import { parseBodyOr400, resolveUserId } from '../../lib/route-helpers.js';
import { authorizeMeetingBooking } from '../../services/meetings/authorize-meeting-booking.js';
import {
  bookAndProvisionMeeting,
  lookupBookingReplay,
  BookingIdempotencyKeyConflictError,
  type BookAndProvisionInput,
  type BookingReplayProbe,
} from '../../services/meetings/provision-meeting.js';
import { createMeetingBodySchema } from './schema.js';
import { meetingGuestRoutes } from './guests.js';
import { meetingJoinRoutes } from './join.js';
import { meetingEndRoutes } from './end.js';
import { meetingStateRoutes } from './state.js';
import { meetingRescheduleRoutes } from './reschedule.js';
import { meetingCancelRoutes } from './cancel.js';
import { meetingRescheduleProposalRoutes } from './reschedule-proposals.js';
import { meetingRescheduleProposalAnswerRoutes } from './reschedule-proposal-answers.js';
import {
  BOOKING_USER_RATE_LIMIT,
  WINDOW_VIOLATION_CODE,
  enforceBookingRateLimit,
  enforceExpertScopedGuards,
} from './guards.js';

const log = createLogger('meetings-route');

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
  // BAL-400 (Decision 7) — a `bookingIdempotencyKey` that already names a meeting booked
  // against a DIFFERENT context. Same-user key reuse against a different case.
  if (error instanceof BookingIdempotencyKeyConflictError) {
    return { status: 409, error: 'idempotency_key_conflict' };
  }
  return null;
}

/**
 * BAL-400 (S3/M1) — is this submit an EXACT idempotent replay of a booking that already
 * exists? `true` ⇒ the expert-scoped guards are skipped (see the module docblock for why that
 * is safe and why it is necessary). A missing key, an unknown key, or a key naming a different
 * case/window all answer `false`, so every non-replay keeps the guards it always had.
 *
 * ⚠ NEVER call this before `authorizeMeetingBooking`. The key proves who minted it, not what
 * the actor may book.
 */
/**
 * ⚠ THIS LOOKUP IS DELIBERATELY REPEATED INSIDE THE SERVICE — DO NOT "OPTIMISE" IT AWAY.
 *
 * `lookupBookingReplay` runs here (to decide whether to SKIP the availability gate and the
 * per-pair limit) and again inside `replayByIdempotencyKey` (to decide WHAT to return). That
 * is one extra indexed read, on the retry path only, and it buys a property worth more than
 * the read: the service NEVER TRUSTS ITS CALLER'S VERDICT.
 *
 * Collapsing the two — threading this result down as a parameter — would make the service's
 * behaviour a function of what a caller asserts rather than of what the database says. The
 * service is also reachable as a repair entry point independent of this route, so a caller
 * asserting "this is an exact replay" must never be able to make it act on that claim alone.
 * Re-deriving is the same defence-in-depth posture as the gate ordering documented above.
 */
async function isExactBookingReplay(
  bookingIdempotencyKey: string | undefined,
  probe: BookingReplayProbe
): Promise<boolean> {
  if (bookingIdempotencyKey === undefined) {
    return false;
  }
  const lookup = await lookupBookingReplay(bookingIdempotencyKey, probe);
  return lookup.kind === 'match';
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

  // BAL-400 (S3/M1) — resolved HERE, after the gate and before the two expert-scoped guards.
  const replaying = await isExactBookingReplay(parsed.bookingIdempotencyKey, {
    contextType,
    contextId,
    scheduledStart,
    scheduledEnd,
  });

  // A `null` expert means a `match`-routed `project_discovery`: there is no calendar to rate
  // limit against and none to check availability on. The repository throws
  // `MatchModeDiscoveryNotBookableError`, which maps to `409 discovery_not_routed` — so this is
  // a skip, not a bypass.
  if (
    !replaying &&
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
    bookingIdempotencyKey: parsed.bookingIdempotencyKey,
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

  // BAL-134 — the server END endpoint and the polled STATE read. Sibling registrations, same
  // reasoning as the two above: one prefix, one `requireAuth` idiom.
  // ⚠ BOTH ARE AUTHENTICATED, unlike two of the three join routes. Ending a meeting is a
  // mutation over a money-bearing record; the state read is member-only because the two guest
  // surfaces mount no route context and already render neutral copy.
  await meetingEndRoutes(fastify);
  await meetingStateRoutes(fastify);

  // BAL-409 — client-initiated reschedule. A sibling registration, same reasoning as the
  // routes above: one prefix, one `requireAuth` idiom.
  await meetingRescheduleRoutes(fastify);

  // BAL-410 — cancel a booked consultation (client / expert / admin, three axes). A sibling
  // registration for the same reason as every route above; it is the FIRST shipped surface that
  // frees a booked slot again.
  await meetingCancelRoutes(fastify);

  // BAL-411 — expert-initiated reschedule PROPOSALS. Two sibling registrations split by axis
  // (engagement vs membership) so the two API gate modules can never be folded into one.
  await meetingRescheduleProposalRoutes(fastify);
  await meetingRescheduleProposalAnswerRoutes(fastify);

  log.info('Registered meeting routes');
}
