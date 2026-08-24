/**
 * BAL-411 — the EXPERT arm: `POST /meetings/:meetingId/reschedule-proposals` (create) and
 * `POST /meetings/:meetingId/reschedule-proposals/:proposalId/withdraw`.
 *
 * Guards extracted into `resolveProposeInput`, mirroring `reschedule.ts`'s
 * `resolveRescheduleInput`, to stay under SonarCloud's cognitive-complexity ceiling of 15.
 *
 * ── SEQUENCE (propose) ──────────────────────────────────────────────────────────────────────
 *   requireAuth → resolveUserId (401, defensive)
 *     → per-user rate limit (RESCHEDULE_PROPOSAL_USER_RATE_LIMIT) → 429 / 503 (fail-CLOSED)
 *     → params: meetingIdParamsSchema                              → 400 invalid_request
 *     → body: proposeRescheduleBodySchema                          → 400 invalid_request
 *     → authorizeMeetingRescheduleProposal(...) — ENGAGEMENT AXIS  → 404 meeting_not_found
 *     → case liveness (closed_at IS NULL) — PROPOSE-ONLY            → 409 case_closed
 *     → resolveRescheduleRefusal(status, scheduledStart, now)       → 409 meeting_not_reschedulable
 *     → per-option: pin scheduledEnd from the meeting's OWN duration, validateBookingWindow
 *       → 400 <stable code>, duplicate start → 400 duplicate_option
 *     → per-option: isWindowAvailableForExpert(..., excludeMeeting) → 409 window_not_available
 *     → proposeReschedule(...)                                      → 200
 *        └── RescheduleProposalAlreadyPendingError                  → 409 proposal_already_pending
 *
 * ⚠⚠ AUTHORIZATION BEFORE ANY STATE CHECK — same discipline as `reschedule.ts`'s membership
 * gate, on the ENGAGEMENT axis instead. `authorizeMeetingRescheduleProposal` collapses every
 * denial into ONE `meeting_not_found` literal; running the case-liveness or meeting-state
 * check first would let an actor with no engagement-axis grant anywhere distinguish states of a
 * guessed `meetingId` by status code alone.
 *
 * ⚠ CASE LIVENESS IS PROPOSE-ONLY. Withdraw does NOT check it — withdrawing an existing ask on
 * a case that closed afterward is harmless and creates nothing new; only proposing a NEW ask on
 * a closed case is refused.
 */
import {
  RescheduleProposalAlreadyPendingError,
  agenciesRepository,
  caseEngagementsRepository,
  expertsRepository,
  meetingCalendarEventsRepository,
  usersRepository,
} from '@balo/db';
import { validateBookingWindow, resolveRescheduleRefusal } from '@balo/shared/meetings';
import { expertPartyDisplayName } from '@balo/shared/parties';
import { createLogger } from '@balo/shared/logging';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../../lib/require-auth.js';
import { parseBodyOr400, resolveUserId } from '../../lib/route-helpers.js';
import { authorizeMeetingRescheduleProposal } from '../../services/meetings/authorize-meeting-reschedule-proposal.js';
import { isWindowAvailableForExpert } from '../../services/availability/window-availability.js';
import {
  proposeReschedule,
  withdrawRescheduleProposal,
} from '../../services/meetings/reschedule-proposals.js';
import {
  RESCHEDULE_PROPOSAL_USER_RATE_LIMIT,
  WINDOW_VIOLATION_CODE,
  enforceBookingRateLimit,
} from './guards.js';
import { meetingIdParamsSchema } from './join.schema.js';
import {
  meetingProposalIdParamsSchema,
  proposeRescheduleBodySchema,
  type ProposeRescheduleBody,
} from './reschedule-proposals.schema.js';

const log = createLogger('meeting-reschedule-proposal-route');

interface ResolvedProposeOption {
  scheduledStart: Date;
  scheduledEnd: Date;
}

interface ResolvedProposeInput {
  meetingId: string;
  engagementId: string;
  companyId: string;
  expertProfileId: string;
  proposedByUserId: string;
  originalScheduledStart: Date;
  expertPartyLabel: string;
  caseTitle: string;
  options: ResolvedProposeOption[];
}

/** `expertPartyDisplayName`, resolved for the ONE recipient this route needs it for: the
 *  BAL-420 reminder payload. Degrades to a neutral fallback rather than blocking the propose —
 *  a missing profile/user row here is a data-integrity oddity, not a reason to refuse the ask.
 *
 *  Fix round 1 item 16 (security LOW) — `findDisplayProfileById` / `findDisplayById`, the
 *  PROJECTED reads, not `findProfileById` / `findById`. This value goes straight into
 *  `RescheduleProposalUnansweredPayload.expertPartyLabel`; every other label resolution in this
 *  ticket already uses the projected reads, and a full-row `findById` would carry
 *  `email`/`workosId`/`phone`/`platformRole` for two name fields nobody asked for. */
async function resolveExpertPartyLabel(expertProfileId: string): Promise<string> {
  const profile = await expertsRepository.findDisplayProfileById(expertProfileId);
  if (profile === undefined) {
    return 'Your expert';
  }
  const [expertUser, agency] = await Promise.all([
    usersRepository.findDisplayById(profile.userId),
    profile.agencyId === null
      ? Promise.resolve(undefined)
      : agenciesRepository.getSummaryById(profile.agencyId),
  ]);
  return expertPartyDisplayName({
    type: profile.type,
    agencyName: agency?.name ?? null,
    firstName: expertUser?.firstName ?? null,
    lastName: expertUser?.lastName ?? null,
  });
}

/** The meeting facts `resolveProposeOptions` needs, grouped into one object so the function
 *  stays under the parameter-count ceiling (SonarCloud max 7) — six meeting facts plus
 *  `body`/`now`/`reply` was 9. */
interface ProposeOptionContext {
  readonly meetingId: string;
  readonly expertProfileId: string;
  readonly currentDurationMs: number;
  readonly meetingScheduledStart: Date;
  readonly meetingScheduledEnd: Date;
  readonly hasVendorEvent: boolean;
}

/** Every per-option guard, in order. Bails via `reply` on the FIRST violation across the whole
 *  set — extracted so `resolveProposeInput` stays under the complexity ceiling. */
async function resolveProposeOptions(
  body: ProposeRescheduleBody,
  ctx: ProposeOptionContext,
  now: Date,
  reply: FastifyReply
): Promise<ResolvedProposeOption[] | null> {
  const {
    meetingId,
    expertProfileId,
    currentDurationMs,
    meetingScheduledStart,
    meetingScheduledEnd,
    hasVendorEvent,
  } = ctx;
  const seenStarts = new Set<number>();
  const options: ResolvedProposeOption[] = [];

  for (const raw of body.options) {
    const scheduledStart = new Date(raw.scheduledStart);
    const scheduledEnd = new Date(scheduledStart.getTime() + currentDurationMs);

    const violation = validateBookingWindow(scheduledStart, scheduledEnd, now);
    if (violation !== null) {
      reply.code(400).send({ error: WINDOW_VIOLATION_CODE[violation] });
      return null;
    }
    if (seenStarts.has(scheduledStart.getTime())) {
      reply.code(400).send({ error: 'duplicate_option' });
      return null;
    }
    // Fix round 1 item 4(a) — an option matching the meeting's CURRENT start is never a real
    // ask (proposing the time you already have). Left unchecked, `isWindowAvailableForExpert`
    // would report it available (its `excludeMeeting` subtracts the meeting's own booking from
    // the collision check) and accepting it would move the meeting to the instant it was
    // already at — the exact self-start shape that lets a compensating revert re-open an
    // already-committed accept for a second write. See `reschedule-proposals.ts` (service)
    // `revertAccept` for the other half of this fix.
    if (scheduledStart.getTime() === meetingScheduledStart.getTime()) {
      reply.code(400).send({ error: 'duplicate_option' });
      return null;
    }
    seenStarts.add(scheduledStart.getTime());
    options.push({ scheduledStart, scheduledEnd });
  }

  // Up to RESCHEDULE_PROPOSAL_MAX_OPTIONS vendor free/busy round-trips — one per option.
  // `excludeMeeting` is the meeting's OWN current window, so a proposed slot overlapping the
  // meeting's own booking is never a false self-collision (BAL-409 D7 precedent).
  for (const option of options) {
    const available = await isWindowAvailableForExpert(
      expertProfileId,
      option.scheduledStart,
      option.scheduledEnd,
      now,
      {
        meetingId,
        currentStart: meetingScheduledStart,
        currentEnd: meetingScheduledEnd,
        hasVendorEvent,
      }
    );
    if (!available) {
      log.info(
        { meetingId, expertProfileId },
        'Reschedule proposal refused — option window not available'
      );
      reply.code(409).send({ error: 'window_not_available' });
      return null;
    }
  }

  return options;
}

async function resolveProposeInput(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string
): Promise<ResolvedProposeInput | null> {
  if (await enforceBookingRateLimit(RESCHEDULE_PROPOSAL_USER_RATE_LIMIT, userId, reply))
    return null;

  const params = meetingIdParamsSchema.safeParse(request.params);
  if (!params.success) {
    reply.code(400).send({ error: 'invalid_request' });
    return null;
  }
  const { meetingId } = params.data;

  const body = parseBodyOr400(proposeRescheduleBodySchema, request, reply);
  if (body === null) return null;

  // ── ENGAGEMENT-AXIS AUTHORIZATION BEFORE ANY STATE CHECK. ──
  const authorized = await authorizeMeetingRescheduleProposal({ meetingId, userId });
  if (!authorized.ok) {
    reply.code(404).send({ error: authorized.code });
    return null;
  }
  const { meeting, engagementId, companyId, expertProfileId } = authorized;

  // Case liveness — PROPOSE-ONLY. See the module docblock for why withdraw does not repeat it.
  const caseRow = await caseEngagementsRepository.findByEngagementId(engagementId);
  if (caseRow === undefined || caseRow.closedAt !== null) {
    reply.code(409).send({ error: 'case_closed' });
    return null;
  }

  const now = new Date();
  const refusal = resolveRescheduleRefusal(meeting.status, meeting.scheduledStart, now);
  if (refusal !== null) {
    reply.code(409).send({ error: 'meeting_not_reschedulable' });
    return null;
  }

  const currentDurationMs = meeting.scheduledEnd.getTime() - meeting.scheduledStart.getTime();
  const hasVendorEvent =
    (await meetingCalendarEventsRepository.findLiveByMeetingId(meetingId)) !== undefined;

  const options = await resolveProposeOptions(
    body,
    {
      meetingId,
      expertProfileId,
      currentDurationMs,
      meetingScheduledStart: meeting.scheduledStart,
      meetingScheduledEnd: meeting.scheduledEnd,
      hasVendorEvent,
    },
    now,
    reply
  );
  if (options === null) return null;

  const expertPartyLabel = await resolveExpertPartyLabel(expertProfileId);

  return {
    meetingId,
    engagementId,
    companyId,
    expertProfileId,
    proposedByUserId: userId,
    originalScheduledStart: meeting.scheduledStart,
    expertPartyLabel,
    caseTitle: caseRow.title,
    options,
  };
}

interface ResolvedWithdrawInput {
  meetingId: string;
  proposalId: string;
  userId: string;
}

async function resolveWithdrawInput(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string
): Promise<ResolvedWithdrawInput | null> {
  if (await enforceBookingRateLimit(RESCHEDULE_PROPOSAL_USER_RATE_LIMIT, userId, reply))
    return null;

  const params = meetingProposalIdParamsSchema.safeParse(request.params);
  if (!params.success) {
    reply.code(400).send({ error: 'invalid_request' });
    return null;
  }
  const { meetingId, proposalId } = params.data;

  const authorized = await authorizeMeetingRescheduleProposal({ meetingId, userId });
  if (!authorized.ok) {
    reply.code(404).send({ error: authorized.code });
    return null;
  }

  return { meetingId, proposalId, userId };
}

export async function meetingRescheduleProposalRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/meetings/:meetingId/reschedule-proposals',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;

      const input = await resolveProposeInput(request, reply, userId);
      if (input === null) return;

      try {
        const { proposal, options } = await proposeReschedule(
          {
            meetingId: input.meetingId,
            engagementId: input.engagementId,
            companyId: input.companyId,
            expertPartyLabel: input.expertPartyLabel,
            caseTitle: input.caseTitle,
            proposedByUserId: input.proposedByUserId,
            originalScheduledStart: input.originalScheduledStart,
            options: input.options,
            now: new Date(),
          },
          request.log
        );

        reply.code(200).send({
          proposalId: proposal.id,
          meetingId: input.meetingId,
          expiresAtIso: proposal.expiresAt.toISOString(),
          options: options.map((option) => ({
            optionId: option.id,
            scheduledStart: option.scheduledStart.toISOString(),
            scheduledEnd: option.scheduledEnd.toISOString(),
            position: option.position,
          })),
        });
      } catch (error) {
        if (error instanceof RescheduleProposalAlreadyPendingError) {
          log.info(
            { meetingId: input.meetingId, userId: input.proposedByUserId },
            'Reschedule proposal refused — one is already pending on this meeting'
          );
          reply.code(409).send({ error: 'proposal_already_pending' });
          return;
        }
        log.error(
          {
            meetingId: input.meetingId,
            userId: input.proposedByUserId,
            errorName: error instanceof Error ? error.name : 'unknown',
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          'Reschedule proposal failed'
        );
        throw error;
      }
    }
  );

  fastify.post(
    '/meetings/:meetingId/reschedule-proposals/:proposalId/withdraw',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = resolveUserId(request, reply);
      if (userId === null) return;

      const input = await resolveWithdrawInput(request, reply, userId);
      if (input === null) return;

      const result = await withdrawRescheduleProposal(
        {
          proposalId: input.proposalId,
          meetingId: input.meetingId,
          actorUserId: input.userId,
          now: new Date(),
        },
        request.log
      );

      if (result === undefined) {
        reply.code(409).send({ error: 'proposal_not_answerable' });
        return;
      }

      reply.code(200).send({ proposalId: result.id, status: 'withdrawn' });
    }
  );

  log.info('Registered meeting reschedule-proposal (expert) routes');
}
