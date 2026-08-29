/**
 * BAL-410 — `POST /meetings/:meetingId/cancel`: cancel a booked consultation, free until the
 * scheduled start. There is no fee, no cutoff and no partial capture (ADR-1040) — the credit
 * hold, if one exists, is released in full.
 *
 * ── SEQUENCE ────────────────────────────────────────────────────────────────
 *   requireAuth → resolveUserId (401, defensive)
 *     → per-USER rate limit (CANCEL_USER_RATE_LIMIT)   → 429 / 503 (fail-CLOSED)
 *     → params: meetingIdParamsSchema (bare safeParse, no `details`)  → 400 invalid_request
 *     → body: cancelMeetingBodySchema (`.strict()`, EMPTY)            → 400 invalid_request
 *     → authorizeMeetingCancel(...)                    → 404 meeting_not_found
 *     → resolveCancelRefusal(meeting.status)           → 409 meeting_not_cancellable
 *     → cancelMeeting(...)                             → 200
 *        └── MeetingNotCancellableError (TOCTOU)        → 409, NO message echo
 *     → publishBookingCancelled(...)                    fail-soft, never changes the status code
 *
 * ⚠⚠ MEMBERSHIP BEFORE STATE. `authorizeMeetingCancel` runs BEFORE `resolveCancelRefusal` —
 * running any state check first would let an actor with no membership anywhere distinguish
 * states of a guessed `meetingId` by status code alone, i.e. an existence oracle over every
 * meeting on the platform. See `authorize-meeting-cancel.ts`'s docblock for the full argument.
 *
 * ⚠ THREE AXES, ONE PER ACTOR, AND NO ROLE CHECK ANYWHERE IN THIS FILE. The route never asks
 * WHO the caller is; it asks the gate which ARM matched and threads that answer (`actorRole`)
 * into the audit row, the analytics property and the notification copy. It is server-derived by
 * construction and cannot be spoofed — which is why `cancelMeetingBodySchema` is empty and
 * `.strict()`.
 *
 * ⚠ THERE IS NO EXPERT-SCOPED GUARD, deliberately. `enforceExpertScopedGuards` protects an
 * expert's published calendar from being CONSUMED; a cancel only ever frees a slot and performs
 * no vendor free/busy round-trip, so there is nothing scarce to protect. See `guards.ts`.
 *
 * ⚠ THIS ROUTE IS THE `log.error` BOUNDARY. Every mapped branch logs the full message and stack
 * SERVER-SIDE and sends only a FIXED LITERAL — `MeetingNotCancellableError.message` embeds a raw
 * `meetingId` and must never reach the client.
 *
 * ⚠ THE PUBLISH IS HERE RATHER THAN IN `cancelMeeting`, and that is not tidiness. The dev seeder
 * is a live caller of `cancelMeeting`; publishing from the service would send real cancellation
 * emails on every `pnpm db:seed`. The route is unreachable from the seeder.
 */
import { MeetingNotCancellableError } from '@balo/db';
import { resolveCancelRefusal } from '@balo/shared/meetings';
import { createLogger } from '@balo/shared/logging';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../../lib/require-auth.js';
import { parseBodyOr400, resolveUserId } from '../../lib/route-helpers.js';
import {
  authorizeMeetingCancel,
  type CancelActorRole,
} from '../../services/meetings/authorize-meeting-cancel.js';
import {
  cancelMeeting,
  type CancelMeetingOutcome,
} from '../../services/meetings/meeting-availability.js';
import { publishBookingCancelled } from '../../services/meetings/publish-booking-cancelled.js';
import type { PrimaryMeetingContext } from '@balo/shared/meetings';
import { CANCEL_USER_RATE_LIMIT, enforceBookingRateLimit } from './guards.js';
import { meetingIdParamsSchema } from './join.schema.js';
import { cancelMeetingBodySchema } from './cancel.schema.js';

const log = createLogger('meeting-cancel-route');

interface ResolvedCancelInput {
  meetingId: string;
  userId: string;
  actorRole: CancelActorRole;
  subject: PrimaryMeetingContext;
  companyId: string | null;
  expertProfileId: string | null;
}

/**
 * EVERY PRE-CANCEL GUARD, IN ORDER — returns the validated service input, or `null` when a reply
 * has already been sent.
 *
 * ⚠ EXTRACTED, matching `reschedule.ts`'s `resolveRescheduleInput` and
 * `routes/meetings/index.ts`'s `resolveBookingInput` — keeps the handler a two-step read and
 * stays under SonarCloud's cognitive-complexity ceiling of 15.
 */
async function resolveCancelInput(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string
): Promise<ResolvedCancelInput | null> {
  if (await enforceBookingRateLimit(CANCEL_USER_RATE_LIMIT, userId, reply)) return null;

  // Bare safeParse, no `details` — a param id echoed back would be a uuid on the wire (the
  // house pattern, `state.ts`).
  const params = meetingIdParamsSchema.safeParse(request.params);
  if (!params.success) {
    reply.code(400).send({ error: 'invalid_request' });
    return null;
  }
  const { meetingId } = params.data;

  // Zod `details` ARE echoed — house style, Zod messages carry no server-side uuid. The schema
  // is EMPTY and `.strict()`, so any field (notably `reason`) is a 400 rather than being
  // silently stripped. See `cancel.schema.ts`.
  const body = parseBodyOr400(cancelMeetingBodySchema, request, reply);
  if (body === null) return null;

  // ── MEMBERSHIP BEFORE STATE — see the module docblock. ──
  const authorized = await authorizeMeetingCancel({ meetingId, userId });
  if (!authorized.ok) {
    reply.code(404).send({ error: authorized.code });
    return null;
  }

  // ⚠ STATE ONLY AFTER AUTHORIZATION. `resolveCancelRefusal` reads NO clock (D5): "free until
  // the scheduled start" is delivered by the status allow-list, because the first presence
  // interval flips a joined meeting out of `scheduled`.
  const refusal = resolveCancelRefusal(authorized.meeting.status);
  if (refusal !== null) {
    reply.code(409).send({ error: 'meeting_not_cancellable' });
    return null;
  }

  return {
    meetingId,
    userId,
    actorRole: authorized.actorRole,
    subject: authorized.subject,
    companyId: authorized.companyId,
    expertProfileId: authorized.expertProfileId,
  };
}

/** The `{ errorName, error, stack }` triple shared by every `log.error` catch below — DRY. */
function toErrorLogFields(error: unknown): {
  errorName: string;
  error: string;
  stack: string | undefined;
} {
  return {
    errorName: error instanceof Error ? error.name : 'unknown',
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

/**
 * FAIL-SOFT PUBLISH — see the module docblock. The cancellation has already committed by the
 * time this runs; a publish failure must never turn it into a 500 and must never change the
 * status code the caller already earned, so it is logged and swallowed, never re-thrown.
 *
 * ⚠ EXTRACTED alongside `toErrorLogFields`, for the same reason as `resolveCancelInput` — keeps
 * the route handler a flat read and stays under SonarCloud's cognitive-complexity ceiling of 15.
 */
async function publishCancellationFailSoft(
  input: ResolvedCancelInput,
  result: CancelMeetingOutcome,
  requestLog: FastifyBaseLogger
): Promise<void> {
  try {
    await publishBookingCancelled(
      {
        meetingId: input.meetingId,
        subject: input.subject,
        companyId: input.companyId,
        expertProfileId: input.expertProfileId,
        actorUserId: input.userId,
        cancelledBy: input.actorRole,
        scheduledStart: result.meeting.scheduledStart,
        scheduledEnd: result.meeting.scheduledEnd,
        cancelAuditId: result.cancelAuditId,
        holdReleased: result.holdReleased,
      },
      requestLog
    );
  } catch (error) {
    log.error(
      {
        meetingId: input.meetingId,
        userId: input.userId,
        ...toErrorLogFields(error),
      },
      'Failed to publish booking.cancelled — the cancellation itself already committed'
    );
  }
}

export async function meetingCancelRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/meetings/:meetingId/cancel',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;

      const input = await resolveCancelInput(request, reply, userId);
      if (input === null) return;

      try {
        const result = await cancelMeeting(
          input.meetingId,
          input.userId,
          input.actorRole,
          request.log
        );

        // ⚠ THE BUSINESS EVENT, at `info` — CLAUDE.md's "key business events" rule. `holdReleased`
        // is on it deliberately: it is the only observable evidence the money unwind ran, and
        // nothing on screen reflects it.
        log.info(
          {
            meetingId: input.meetingId,
            userId: input.userId,
            initiatedBy: input.actorRole,
            holdReleased: result.holdReleased,
            cancelAuditId: result.cancelAuditId,
          },
          'Consultation cancelled'
        );

        reply.code(200).send({
          meetingId: result.meeting.id,
          status: 'cancelled' as const,
          // The window that was RELEASED — the server's value, never anything from the request.
          scheduledStart: result.meeting.scheduledStart.toISOString(),
          // ⚠ THE FAN-OUT KEY. The `meeting.cancelled` audit row id — unique per WRITE, where a
          // bare `meetingId` is unique only per MEETING and would be swallowed by BullMQ's
          // retained-completed set. It is an opaque append-only-log id: it names no party and
          // leaks nothing. BAL-476 consumes it as the correlation handle for the calendar and
          // ICS withdrawal.
          cancelAuditId: result.cancelAuditId,
          // Authoritative for the caller's analytics — the web must NOT re-derive it.
          initiatedBy: input.actorRole,
          // ⚠⚠ THE CLIENT ARM ONLY (security LOW-1). The hold is the CLIENT's money, and the
          // in-app expert template already withholds hold language on exactly that ground —
          // "the expert has no business being told about its state". Returning it on the expert
          // and admin arms would hand the delivering expert (and their agency owner/admin, and
          // Balo staff) the fact that the client had been admitted early with a funded wallet,
          // which no surface is entitled to show them. THE KEY IS OMITTED, NOT SET TO `false`:
          // `false` would be a claim, and an untrue one whenever a hold really was released.
          ...(input.actorRole === 'client' ? { holdReleased: result.holdReleased } : {}),
        });

        // ⚠ AFTER THE REPLY IS BUILT, AND FAIL-SOFT — see `publishCancellationFailSoft`.
        await publishCancellationFailSoft(input, result, request.log);
        return;
      } catch (error) {
        if (error instanceof MeetingNotCancellableError) {
          // ⚠ THE TOCTOU BACKSTOP. NO message echo — `.message` embeds a raw meetingId.
          log.error(
            {
              meetingId: input.meetingId,
              userId: input.userId,
              ...toErrorLogFields(error),
            },
            'Meeting cancel failed — TOCTOU: meeting flipped state before the write'
          );
          reply.code(409).send({ error: 'meeting_not_cancellable' });
          return;
        }
        log.error(
          {
            meetingId: input.meetingId,
            userId: input.userId,
            ...toErrorLogFields(error),
          },
          'Meeting cancel failed'
        );
        throw error;
      }
    }
  );

  log.info('Registered meeting cancel route');
}
