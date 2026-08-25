/**
 * BAL-411 (§D7) — the CLIENT arm: `POST .../accept` and `POST .../decline`. Split into its OWN
 * file, on its OWN axis, so the two API gate modules can never be folded into one "reschedule
 * proposal" gate — `authorize-meeting-reschedule.ts`'s docblock states this by name.
 *
 * ── SEQUENCE (accept) ───────────────────────────────────────────────────────────────────────
 *   requireAuth → resolveUserId (401, defensive)
 *     → per-user rate limit (RESCHEDULE_USER_RATE_LIMIT, REUSED — accept/decline are
 *       membership-axis reschedule acts, the same abuse shape as a plain reschedule)
 *     → params: meetingProposalIdParamsSchema                          → 400 invalid_request
 *     → body: acceptRescheduleProposalBodySchema (accept only)          → 400 invalid_request
 *     → authorizeMeetingReschedule(...) — MEMBERSHIP AXIS, REUSED VERBATIM → 404 meeting_not_found
 *     → findPendingForAnswer({proposalId, meetingId})                   → 409 proposal_not_answerable
 *     → resolveProposalAnswerRefusal(...)                               → 409 proposal_not_answerable
 *                                                                          | proposal_stale
 *     → the named option must belong to this proposal                   → 409 proposal_not_answerable
 *     → resolveRescheduleRefusal(status, scheduledStart, now)           → 409 meeting_not_reschedulable
 *     → B2-style duration re-pin from the meeting's OWN duration
 *     → enforceExpertScopedGuards(..., excludeMeeting)                  → 409 window_not_available
 *     → acceptRescheduleProposal(...)                                   → 200
 *        ├── `undefined` (CAS lost the race)                            → 409 proposal_not_answerable
 *        └── MeetingNotReschedulableError (TOCTOU)                      → 409, NO message echo
 *
 * ⚠⚠ MEMBERSHIP BEFORE STATE — same discipline `reschedule.ts` documents at length:
 * `authorizeMeetingReschedule` runs BEFORE any proposal/meeting state check.
 *
 * ⚠ THIS ROUTE IS THE `log.error` BOUNDARY for the accept path. Every mapped branch logs the
 * full message and stack SERVER-SIDE and sends only a FIXED LITERAL.
 */
import {
  MeetingNotReschedulableError,
  meetingCalendarEventsRepository,
  rescheduleProposalsRepository,
} from '@balo/db';
import { resolveProposalAnswerRefusal, resolveRescheduleRefusal } from '@balo/shared/meetings';
import { createLogger } from '@balo/shared/logging';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../../lib/require-auth.js';
import { parseBodyOr400, resolveUserId } from '../../lib/route-helpers.js';
import { authorizeMeetingReschedule } from '../../services/meetings/authorize-meeting-reschedule.js';
import {
  acceptRescheduleProposal,
  declineRescheduleProposal,
} from '../../services/meetings/reschedule-proposals.js';
import {
  RESCHEDULE_USER_RATE_LIMIT,
  enforceBookingRateLimit,
  enforceExpertScopedGuards,
} from './guards.js';
import {
  acceptRescheduleProposalBodySchema,
  meetingProposalIdParamsSchema,
} from './reschedule-proposals.schema.js';

const log = createLogger('meeting-reschedule-proposal-answer-route');

/** One literal for every answer-time refusal that is NOT `stale`. */
const NOT_ANSWERABLE = { error: 'proposal_not_answerable' } as const;

interface ResolvedAcceptInput {
  meetingId: string;
  proposalId: string;
  optionId: string;
  userId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  expertProfileId: string | null;
}

interface ResolvedProposalParams {
  meetingId: string;
  proposalId: string;
}

/**
 * Fix round 2 item 4 — the rate limit + `:meetingId/:proposalId` params parse, shared by
 * `resolveAcceptInput` and `resolveDeclineInput` (a self-duplication within this file). Already
 * replies (429 / 400) and returns `null` on a failure the caller must not act on further.
 */
async function resolveProposalParams(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string
): Promise<ResolvedProposalParams | null> {
  if (await enforceBookingRateLimit(RESCHEDULE_USER_RATE_LIMIT, userId, reply)) return null;

  const params = meetingProposalIdParamsSchema.safeParse(request.params);
  if (!params.success) {
    reply.code(400).send({ error: 'invalid_request' });
    return null;
  }
  return params.data;
}

async function resolveAcceptInput(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string
): Promise<ResolvedAcceptInput | null> {
  const proposalParams = await resolveProposalParams(request, reply, userId);
  if (proposalParams === null) return null;
  const { meetingId, proposalId } = proposalParams;

  const body = parseBodyOr400(acceptRescheduleProposalBodySchema, request, reply);
  if (body === null) return null;

  // ── MEMBERSHIP BEFORE STATE. ──
  const authorized = await authorizeMeetingReschedule({ meetingId, userId });
  if (!authorized.ok) {
    reply.code(404).send({ error: authorized.code });
    return null;
  }
  const { meeting, expertProfileId } = authorized;

  const found = await rescheduleProposalsRepository.findPendingForAnswer({ proposalId, meetingId });
  const now = new Date();

  if (found === undefined) {
    reply.code(409).send(NOT_ANSWERABLE);
    return null;
  }
  const { proposal, options } = found;

  const refusal = resolveProposalAnswerRefusal({
    status: proposal.status,
    expiresAt: proposal.expiresAt,
    originalScheduledStart: proposal.originalScheduledStart,
    meetingScheduledStart: meeting.scheduledStart,
    now,
  });
  if (refusal === 'stale') {
    reply.code(409).send({ error: 'proposal_stale' });
    return null;
  }
  if (refusal !== null) {
    reply.code(409).send(NOT_ANSWERABLE);
    return null;
  }

  // The named option must belong to THIS proposal — one literal, no "unknown option" distinction
  // (§D7 step 5).
  const option = options.find((candidate) => candidate.id === body.optionId);
  if (option === undefined) {
    reply.code(409).send(NOT_ANSWERABLE);
    return null;
  }

  const meetingRefusal = resolveRescheduleRefusal(meeting.status, meeting.scheduledStart, now);
  if (meetingRefusal !== null) {
    reply.code(409).send({ error: 'meeting_not_reschedulable' });
    return null;
  }

  // ⚠ RE-PIN THE DURATION FROM THE LIVE MEETING, AT ACCEPT TIME (§D7 step 7). The stored
  // `option.scheduled_end` is DISPLAY ONLY — never trusted for the write. A meeting whose
  // duration changed between propose and accept must not be moved to a stale-length window.
  const currentDurationMs = meeting.scheduledEnd.getTime() - meeting.scheduledStart.getTime();
  const scheduledStart = option.scheduledStart;
  const scheduledEnd = new Date(scheduledStart.getTime() + currentDurationMs);

  // ⚠ `excludeMeeting` IS NOT OPTIONAL HERE — buffers mean even a non-overlapping option can be
  // blocked by the meeting's own booking (§D7 step 8).
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
    proposalId,
    optionId: option.id,
    userId,
    scheduledStart,
    scheduledEnd,
    expertProfileId,
  };
}

interface ResolvedDeclineInput {
  meetingId: string;
  proposalId: string;
  userId: string;
}

async function resolveDeclineInput(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string
): Promise<ResolvedDeclineInput | null> {
  const proposalParams = await resolveProposalParams(request, reply, userId);
  if (proposalParams === null) return null;
  const { meetingId, proposalId } = proposalParams;

  const authorized = await authorizeMeetingReschedule({ meetingId, userId });
  if (!authorized.ok) {
    reply.code(404).send({ error: authorized.code });
    return null;
  }

  return { meetingId, proposalId, userId };
}

export async function meetingRescheduleProposalAnswerRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.post(
    '/meetings/:meetingId/reschedule-proposals/:proposalId/accept',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;

      const input = await resolveAcceptInput(request, reply, userId);
      if (input === null) return;

      try {
        const result = await acceptRescheduleProposal(
          {
            proposalId: input.proposalId,
            meetingId: input.meetingId,
            actorUserId: input.userId,
            optionId: input.optionId,
            scheduledStart: input.scheduledStart,
            scheduledEnd: input.scheduledEnd,
            now: new Date(),
          },
          request.log
        );

        if (result === undefined) {
          reply.code(409).send(NOT_ANSWERABLE);
          return;
        }

        reply.code(200).send({
          proposalId: result.proposalId,
          meetingId: result.meetingId,
          scheduledStart: result.scheduledStart.toISOString(),
          scheduledEnd: result.scheduledEnd.toISOString(),
          previousScheduledStart: result.previousScheduledStart.toISOString(),
          previousScheduledEnd: result.previousScheduledEnd.toISOString(),
          rescheduleAuditId: result.rescheduleAuditId,
        });
      } catch (error) {
        if (error instanceof MeetingNotReschedulableError) {
          // ⚠ THE TOCTOU BACKSTOP. NO message echo — `.message` embeds a raw meetingId.
          log.error(
            {
              meetingId: input.meetingId,
              proposalId: input.proposalId,
              userId: input.userId,
              errorName: error.name,
              error: error.message,
              stack: error.stack,
            },
            'Reschedule proposal accept failed — TOCTOU: meeting flipped state before the write'
          );
          reply.code(409).send({ error: 'meeting_not_reschedulable' });
          return;
        }
        log.error(
          {
            meetingId: input.meetingId,
            proposalId: input.proposalId,
            userId: input.userId,
            errorName: error instanceof Error ? error.name : 'unknown',
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Reschedule proposal accept failed'
        );
        throw error;
      }
    }
  );

  fastify.post(
    '/meetings/:meetingId/reschedule-proposals/:proposalId/decline',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;

      const input = await resolveDeclineInput(request, reply, userId);
      if (input === null) return;

      const result = await declineRescheduleProposal(
        {
          proposalId: input.proposalId,
          meetingId: input.meetingId,
          actorUserId: input.userId,
          now: new Date(),
        },
        request.log
      );

      if (result === undefined) {
        reply.code(409).send(NOT_ANSWERABLE);
        return;
      }

      reply.code(200).send({ proposalId: result.id, status: 'declined' });
    }
  );

  log.info('Registered meeting reschedule-proposal (client answer) routes');
}
