/**
 * BAL-409 — `POST /meetings/:meetingId/reschedule`: client-initiated reschedule of a booked
 * consultation. Auto-approves (ADR-1044 §4) — no expert confirmation step, because the slot
 * was already offered on the expert's live availability.
 *
 * ── SEQUENCE ────────────────────────────────────────────────────────────────
 *   requireAuth → resolveUserId (401, defensive)
 *     → per-USER rate limit (RESCHEDULE_USER_RATE_LIMIT)  → 429 / 503 (fail-CLOSED)
 *     → params: meetingIdParamsSchema (bare safeParse, no `details`)   → 400 invalid_request
 *     → body: rescheduleMeetingBodySchema                              → 400 invalid_request
 *     → validateBookingWindow(start, requestedEnd, now)  → 400 <stable code> (shape check only)
 *     → authorizeMeetingReschedule(...)                  → 404 meeting_not_found
 *     → B2: PIN scheduledEnd = scheduledStart + meeting's CURRENT duration — the body's
 *       `scheduledEnd` is discarded from here on; see the pin's own comment below
 *     → resolveRescheduleRefusal(status, scheduledStart, now)  → 409 meeting_not_reschedulable
 *     → NO-OP GUARD (requested window === current window) → 200 { changed: false }
 *     → per-(user, expert) rate limit + isWindowAvailableForExpert(..., excludeMeeting)
 *                                                          → 409 window_not_available
 *     → rescheduleMeeting(...)                            → 200
 *        └── MeetingNotReschedulableError (TOCTOU)         → 409, NO message echo
 *
 * ⚠⚠ MEMBERSHIP BEFORE STATE. `authorizeMeetingReschedule` runs BEFORE
 * `resolveRescheduleRefusal` — running any state check first would let an actor with no
 * membership anywhere distinguish states of a guessed `meetingId` by status code alone. See
 * `authorize-meeting-reschedule.ts`'s docblock for the full argument.
 *
 * ⚠ THIS ROUTE IS THE `log.error` BOUNDARY. Every mapped branch logs the full message and
 * stack SERVER-SIDE and sends only a FIXED LITERAL — `MeetingNotReschedulableError.message`
 * embeds a raw `meetingId` and must never reach the client.
 *
 * ⚠ `MeetingContextRequiredError` / `MeetingContextUnresolvableError` are deliberately left
 * UNMAPPED here: the route resolves the context itself through the gate and never passes one
 * to the repository, so they are structurally unreachable from this route.
 */
import {
  MeetingNotReschedulableError,
  meetingCalendarEventsRepository,
  meetingsRepository,
} from '@balo/db';
import { validateBookingWindow, resolveRescheduleRefusal } from '@balo/shared/meetings';
import { createLogger } from '@balo/shared/logging';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../../lib/require-auth.js';
import { parseBodyOr400, resolveUserId } from '../../lib/route-helpers.js';
import { authorizeMeetingReschedule } from '../../services/meetings/authorize-meeting-reschedule.js';
import { rescheduleMeeting } from '../../services/meetings/meeting-availability.js';
import {
  RESCHEDULE_USER_RATE_LIMIT,
  WINDOW_VIOLATION_CODE,
  enforceBookingRateLimit,
  enforceExpertScopedGuards,
} from './guards.js';
import { meetingIdParamsSchema } from './join.schema.js';
import { rescheduleMeetingBodySchema } from './reschedule.schema.js';

const log = createLogger('meeting-reschedule-route');

interface ResolvedRescheduleInput {
  meetingId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  expertProfileId: string | null;
  userId: string;
}

/**
 * EVERY PRE-RESCHEDULE GUARD, IN ORDER — returns the validated service input, `{ noop: true,
 * meetingId }` for the no-op guard, or `null` when a reply has already been sent.
 *
 * ⚠ EXTRACTED, matching `routes/meetings/index.ts`'s `resolveBookingInput` — "'add one more
 * guard' is exactly what the next reschedule/cancel route will want to do." Keeps the handler
 * a two-step read and stays under SonarCloud's cognitive-complexity ceiling of 15.
 */
async function resolveRescheduleInput(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string
): Promise<ResolvedRescheduleInput | { noop: true; meetingId: string } | null> {
  if (await enforceBookingRateLimit(RESCHEDULE_USER_RATE_LIMIT, userId, reply)) return null;

  // Bare safeParse, no `details` — a param id echoed back would be a uuid on the wire (the
  // house pattern, `state.ts`).
  const params = meetingIdParamsSchema.safeParse(request.params);
  if (!params.success) {
    reply.code(400).send({ error: 'invalid_request' });
    return null;
  }
  const { meetingId } = params.data;

  // Zod `details` ARE echoed — house style, Zod messages carry no server-side uuid.
  const body = parseBodyOr400(rescheduleMeetingBodySchema, request, reply);
  if (body === null) return null;

  const scheduledStart = new Date(body.scheduledStart);
  // `requestedScheduledEnd` is used ONLY for the generic shape check below (is this a sane
  // `[start, end)` at all — inverted, too short, too long). It is NEVER passed to the
  // repository — see the B2 duration pin right after authorization resolves the real meeting.
  const requestedScheduledEnd = new Date(body.scheduledEnd);

  const now = new Date();
  const violation = validateBookingWindow(scheduledStart, requestedScheduledEnd, now);
  if (violation !== null) {
    reply.code(400).send({ error: WINDOW_VIOLATION_CODE[violation] });
    return null;
  }

  // ── MEMBERSHIP BEFORE STATE — see the module docblock. ──
  const authorized = await authorizeMeetingReschedule({ meetingId, userId });
  if (!authorized.ok) {
    reply.code(404).send({ error: authorized.code });
    return null;
  }
  const { meeting, expertProfileId } = authorized;

  // ⚠ B2 — PIN THE DURATION AT THE API BOUNDARY. A reschedule moves WHEN a booking happens,
  // never HOW LONG it is: the client's `scheduledEnd` is discarded from this point on, and the
  // ACTUAL end is always recomputed from the meeting's CURRENT (pre-reschedule) duration. Before
  // this fix, the body's raw `scheduledEnd` passed straight through to `rescheduleMeeting`, so a
  // `participate`-holding member could silently stretch a 15-minute consultation to 8 hours —
  // written to the expert's real external calendar with no expert consent, while the guest/
  // expert email copy says "same length, same link". Recomputing (rather than 400ing on a
  // mismatch) means a client-side rounding/timezone quirk in the discarded field can never break
  // the request — only `scheduledStart` is trusted from the body.
  const currentDurationMs = meeting.scheduledEnd.getTime() - meeting.scheduledStart.getTime();
  const scheduledEnd = new Date(scheduledStart.getTime() + currentDurationMs);

  const refusal = resolveRescheduleRefusal(meeting.status, meeting.scheduledStart, now);
  if (refusal !== null) {
    reply.code(409).send({ error: 'meeting_not_reschedulable' });
    return null;
  }

  // NO-OP GUARD — the requested window equals the CURRENT window. 200, nothing written.
  if (
    scheduledStart.getTime() === meeting.scheduledStart.getTime() &&
    scheduledEnd.getTime() === meeting.scheduledEnd.getTime()
  ) {
    return { noop: true, meetingId };
  }

  // `expertProfileId === null` ⇒ a match-routed `project_discovery`. Nothing to rate-limit and
  // no calendar to check, so the expert-scoped guards below are skipped.
  //
  // ⚠ NOT "denied at the gate or by the repository" — NEITHER denies it, and saying so would
  // send the next reader looking for a check that does not exist. It is unreachable for a
  // different reason: such a meeting cannot be CREATED in the first place
  // (`MatchModeDiscoveryNotBookableError` blocks it at booking), so no live row reaches here.
  // The skip is correct either way; only the stated reason was wrong.
  if (expertProfileId !== null) {
    // ⚠ ONLY A `provider_event` COUNTS, AND THAT IS THE POINT OF THE NARROWED READ (BAL-433).
    // `hasVendorEvent` feeds `enforceExpertScopedGuards`' availability exclusion; an
    // ICS-fallback row (ADR-1044 Ruling 1 — no writable connection, so no vendor event exists)
    // answering `true` here would drop a real busy block and let the expert be DOUBLE-BOOKED,
    // typecheck-clean with every mocked test green.
    const hasVendorEvent =
      (await meetingCalendarEventsRepository.findLiveExpertProviderEvent(meetingId)) !== undefined;
    if (
      await enforceExpertScopedGuards(
        {
          userId,
          expertProfileId,
          scheduledStart,
          scheduledEnd,
          excludeMeeting: {
            meetingId,
            currentStart: meeting.scheduledStart,
            currentEnd: meeting.scheduledEnd,
            hasVendorEvent,
          },
        },
        reply
      )
    ) {
      return null;
    }
  }

  return {
    meetingId,
    scheduledStart,
    scheduledEnd,
    expertProfileId,
    userId,
  };
}

export async function meetingRescheduleRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/meetings/:meetingId/reschedule',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;

      const input = await resolveRescheduleInput(request, reply, userId);
      if (input === null) return;

      if ('noop' in input) {
        // Re-read to answer with the CURRENT (unchanged) window, never the client's request.
        const meeting = await meetingsRepository.findById(input.meetingId);
        if (meeting === undefined) {
          reply.code(404).send({ error: 'meeting_not_found' });
          return;
        }
        reply.code(200).send({
          meetingId: input.meetingId,
          scheduledStart: meeting.scheduledStart.toISOString(),
          scheduledEnd: meeting.scheduledEnd.toISOString(),
          previousScheduledStart: meeting.scheduledStart.toISOString(),
          previousScheduledEnd: meeting.scheduledEnd.toISOString(),
          changed: false,
        });
        return;
      }

      try {
        const result = await rescheduleMeeting(
          input.meetingId,
          { scheduledStart: input.scheduledStart, scheduledEnd: input.scheduledEnd },
          input.userId,
          request.log
        );

        reply.code(200).send({
          meetingId: result.meeting.id,
          scheduledStart: result.meeting.scheduledStart.toISOString(),
          scheduledEnd: result.meeting.scheduledEnd.toISOString(),
          previousScheduledStart: result.previous.scheduledStart.toISOString(),
          previousScheduledEnd: result.previous.scheduledEnd.toISOString(),
          changed: true,
          // ⚠ THE FAN-OUT KEY FOR THE CALLER'S OWN `booking.rescheduled` PUBLISH. It is the
          // `meeting.rescheduled` audit row id — unique per MOVE, where a window-derived key
          // is unique only per DESTINATION and therefore collides on a move BACK (A→B→C→B),
          // silently dropping the notification. It is an opaque append-only-log id: it names
          // no party, leaks nothing, and is already the caller's own move.
          rescheduleAuditId: result.rescheduleAuditId,
        });
      } catch (error) {
        if (error instanceof MeetingNotReschedulableError) {
          // ⚠ THE TOCTOU BACKSTOP. NO message echo — `.message` embeds a raw meetingId.
          log.error(
            {
              meetingId: input.meetingId,
              userId: input.userId,
              errorName: error.name,
              error: error.message,
              stack: error.stack,
            },
            'Meeting reschedule failed — TOCTOU: meeting flipped state before the write'
          );
          reply.code(409).send({ error: 'meeting_not_reschedulable' });
          return;
        }
        log.error(
          {
            meetingId: input.meetingId,
            userId: input.userId,
            errorName: error instanceof Error ? error.name : 'unknown',
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Meeting reschedule failed'
        );
        throw error;
      }
    }
  );

  log.info('Registered meeting reschedule route');
}
