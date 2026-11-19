/**
 * BAL-649 (ADR-1058) — the Call now routes. Every handler is thin: authenticate, validate, call
 * one service, map the result. No business rule lives here.
 *
 *   GET  /cases/:engagementId/call-now        the read view (the same gates `POST` enforces)
 *   POST /cases/:engagementId/call-now        start a ring
 *   GET  /call-now/rings/:ringId              a ring's status, to its caller or callee only
 *   POST /call-now/rings/:ringId/decline      the callee turns a ring down (idempotent)
 *   POST /call-now/rings/:ringId/stop         the caller hangs up a ring (idempotent)
 *   POST /call-now/rings/:ringId/answer       the client commits to an EXPERT-STARTED ring (BAL-650)
 *
 * Answering is a route only for an expert-started ring: the client's booking funding check runs
 * here, and the admission follows in the same request. Every other join — the expert's, a
 * client-started ring's callee, and everyone once a ring has connected — is the existing
 * `POST /meetings/:meetingId/join`, and the ring connects on co-presence.
 *
 * ⚠ A FUNDING REFUSAL (start and answer) is `409 { error, code, suggestedTopUpMinor }`, or
 * `503 { error, code }` when the funding snapshot cannot be read. The figure is the client's own
 * all-in top-up (`null` when none is meaningful); no rate, estimate or balance is on the wire.
 *
 * ⚠ THERE IS NO 403. An unknown or unauthorized case is `404 case_not_found`; a ring the user is
 * neither the caller nor the callee of is `404 ring_not_found` from the same query that would
 * find it, so ring ids are no existence oracle. ⚠ The internal `refusal` never reaches the wire — only the display `reason`.
 *
 * ⚠ THIS FILE IS THE `log.error` BOUNDARY: every catch logs the error and answers a fixed
 * `500 internal_error`, never an error message.
 */
import type { MeetingRing } from '@balo/db';
import { meetingRingsRepository, meetingsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { ringAwaitsClientCommit, type CallRingStatus } from '@balo/shared/meetings';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../../lib/require-auth.js';
import { parseBodyOr400, parseParamsOr400, resolveUserId } from '../../lib/route-helpers.js';
import { answerCallNow } from '../../services/call-now/answer-call.js';
import { authorizeCallNow } from '../../services/call-now/authorize-call-now.js';
import { loadCallNowGates } from '../../services/call-now/call-now-gates.js';
import { endRing } from '../../services/call-now/end-ring.js';
import { startCallNow } from '../../services/call-now/start-call.js';
import {
  CASE_BOOKING_FUNDING_STATUS,
  type CaseBookingFundingCode,
} from '../../services/meetings/case-booking-funding.js';
import { enforceBookingRateLimit } from '../meetings/guards.js';
import { sendJoinError, sendMemberJoinGrant } from '../meetings/join.js';
import {
  CALL_NOW_CALLEE_RATE_LIMIT,
  CALL_NOW_RING_ACTION_RATE_LIMIT,
  CALL_NOW_START_RATE_LIMIT,
  CALL_NOW_VIEW_RATE_LIMIT,
  calleeRateLimitIdentifier,
  releaseCalleeRateLimitSlot,
} from './guards.js';
import {
  engagementIdParamsSchema,
  ringIdParamsSchema,
  startCallNowBodySchema,
  startCallNowQuerySchema,
} from './schema.js';

const log = createLogger('call-now-route');

/** One error shape for every authored failure: the house `error` key plus a `code` alias. */
function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  extra: Record<string, unknown> = {}
): void {
  reply.code(status).send({ error: code, code, ...extra });
}

/**
 * A funding refusal, fee-concealed: 409 with the client's top-up figure, or 503 with the code alone
 * when the snapshot was unreadable (no figure exists then).
 */
function sendFundingRefusal(
  reply: FastifyReply,
  code: CaseBookingFundingCode,
  suggestedTopUpMinor: number | null
): void {
  const status = CASE_BOOKING_FUNDING_STATUS[code];
  if (status === 503) {
    sendError(reply, status, code);
    return;
  }
  sendError(reply, status, code, { suggestedTopUpMinor });
}

function handleUnexpected(
  reply: FastifyReply,
  error: unknown,
  context: Record<string, unknown>,
  message: string
): void {
  log.error(
    {
      ...context,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
    message
  );
  sendError(reply, 500, 'internal_error');
}

async function handleView(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = resolveUserId(request, reply);
  if (userId === null) return;
  if (await enforceBookingRateLimit(CALL_NOW_VIEW_RATE_LIMIT, userId, reply)) return;
  const params = parseParamsOr400(engagementIdParamsSchema, request, reply);
  if (params === null) return;
  const { engagementId } = params;

  try {
    const authorized = await authorizeCallNow({ engagementId, userId });
    if (!authorized.ok) {
      sendError(reply, 404, authorized.code);
      return;
    }
    const gates = await loadCallNowGates({
      caseRow: authorized.caseRow,
      side: authorized.side,
      userId,
      mayRing: authorized.mayRing,
      now: new Date(),
    });
    const reason = gates.availability.canCallNow ? null : gates.availability.reason;
    // ⚠ A client's presence is never shown to an expert: the signal exists for the client caller
    // deciding whether to ring an expert, and is `false` whenever the callee is the client.
    const calleeOnline = authorized.side === 'client' && gates.calleeOnline;
    reply.code(200).send({
      canCallNow: gates.availability.canCallNow,
      reason,
      calleeOnline,
      calleeTimeZone: reason === 'outside_hours' ? (gates.callee?.timeZone ?? null) : null,
      inPlaceCandidate:
        gates.inPlaceCandidate === null
          ? null
          : {
              meetingId: gates.inPlaceCandidate.meetingId,
              scheduledStart: gates.inPlaceCandidate.scheduledStart.toISOString(),
            },
    });
  } catch (error) {
    handleUnexpected(reply, error, { engagementId, userId }, 'Call now view failed');
  }
}

async function handleStart(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = resolveUserId(request, reply);
  if (userId === null) return;
  if (await enforceBookingRateLimit(CALL_NOW_START_RATE_LIMIT, userId, reply)) return;
  const params = parseParamsOr400(engagementIdParamsSchema, request, reply);
  if (params === null) return;
  const body = parseBodyOr400(startCallNowBodySchema, request, reply);
  if (body === null) return;
  const { engagementId } = params;
  // A malformed `attemptId` is dropped, never a 400: analytics must not block a call.
  const query = startCallNowQuerySchema.safeParse(request.query);
  const attemptId = query.success ? query.data.attemptId : undefined;

  try {
    const result = await startCallNow({
      engagementId,
      userId,
      inPlaceOfMeetingId: body.inPlaceOfMeetingId,
      attemptId,
      log: request.log,
      meterCallee: (calleeUserId, callingParty) =>
        enforceBookingRateLimit(
          CALL_NOW_CALLEE_RATE_LIMIT,
          calleeRateLimitIdentifier(calleeUserId, callingParty),
          reply
        ),
      releaseCallee: releaseCalleeRateLimitSlot,
    });
    if (result.ok) {
      reply.code(201).send({
        ringId: result.ringId,
        meetingId: result.meetingId,
        placement: result.placement,
        expiresAt: result.expiresAt.toISOString(),
      });
      return;
    }
    switch (result.code) {
      case 'case_not_found':
        sendError(reply, 404, result.code);
        return;
      case 'call_now_unavailable':
        sendError(reply, 409, result.code, { reason: result.reason });
        return;
      case 'in_place_not_allowed':
        sendError(reply, 400, result.code);
        return;
      case 'in_place_not_eligible':
        sendError(reply, 409, result.code);
        return;
      case 'venue_unavailable':
        sendError(reply, 503, result.code);
        return;
      case 'rate_limited':
        // `meterCallee` already answered 429 (or 503 when the limiter is down).
        return;
      case 'account_on_hold':
      case 'booking_unfunded':
      case 'booking_reserved':
      case 'booking_funding_unavailable':
        sendFundingRefusal(reply, result.code, result.suggestedTopUpMinor);
        return;
    }
  } catch (error) {
    handleUnexpected(reply, error, { engagementId, userId }, 'Call now start failed');
  }
}

/**
 * The ring, if the user may see it at all: its caller or its callee. ⚠ The identity check is IN
 * THE QUERY (`findByIdForParty`), so a non-party's read is the same miss as an unknown id.
 */
async function findRingFor(
  ringId: string,
  userId: string
): Promise<{ ring: MeetingRing; role: 'caller' | 'callee' } | undefined> {
  const ring = await meetingRingsRepository.findByIdForParty(ringId, userId);
  if (ring === undefined) return undefined;
  return { ring, role: ring.callerUserId === userId ? 'caller' : 'callee' };
}

/**
 * Whether the ring's meeting is over, so an old link stops opening its room: ended, cancelled, or
 * no longer readable (soft-deleted), since a room with no meeting cannot be joined either.
 */
async function meetingHasEnded(meetingId: string): Promise<boolean> {
  const meeting = await meetingsRepository.findById(meetingId);
  return meeting === undefined || meeting.status === 'ended' || meeting.status === 'cancelled';
}

/**
 * BAL-651 — the caller's analytics correlation, handed to the caller's own room only: the web
 * attempt id and the callee's presence at the start. ⚠ A client's presence is never shown to an
 * expert (the same posture as the case view's `calleeOnline`), so an expert caller always reads
 * `offline`. The callee reads `null` for both.
 */
function callerAnalyticsFields(
  ring: MeetingRing,
  role: 'caller' | 'callee'
): { attemptId: string | null; calleePresenceAtStart: 'online' | 'offline' | null } {
  if (role !== 'caller') {
    return { attemptId: null, calleePresenceAtStart: null };
  }
  const online = ring.callerSide === 'client' && ring.calleeOnlineAtStart === true;
  return { attemptId: ring.attemptId, calleePresenceAtStart: online ? 'online' : 'offline' };
}

async function handleRingRead(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = resolveUserId(request, reply);
  if (userId === null) return;
  const params = parseParamsOr400(ringIdParamsSchema, request, reply);
  if (params === null) return;
  const { ringId } = params;

  try {
    const found = await findRingFor(ringId, userId);
    if (found === undefined) {
      sendError(reply, 404, 'ring_not_found');
      return;
    }
    const { ring, role } = found;
    const awaitsAnswer =
      role === 'callee' &&
      ringAwaitsClientCommit({
        status: ring.status,
        placement: ring.placement,
        callerSide: ring.callerSide,
      });
    const meetingEnded = ring.status === 'connected' && (await meetingHasEnded(ring.meetingId));
    reply.code(200).send({
      ringId: ring.id,
      meetingId: ring.meetingId,
      engagementId: ring.engagementId,
      status: ring.status,
      placement: ring.placement,
      expiresAt: ring.expiresAt.toISOString(),
      role,
      reachedBy: ring.reachedBy,
      awaitsAnswer,
      meetingEnded,
      ...callerAnalyticsFields(ring, role),
    });
  } catch (error) {
    handleUnexpected(reply, error, { ringId, userId }, 'Call now ring read failed');
  }
}

/**
 * Decline (the callee) and stop (the caller) are the same act from opposite ends: the identity
 * check differs and so does the terminal status. A CAS that misses (already connected, expired,
 * or ended) answers `200` with the status the ring actually has.
 */
function ringActionHandler(
  role: 'caller' | 'callee',
  to: 'declined' | 'stopped'
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const userId = resolveUserId(request, reply);
    if (userId === null) return;
    if (await enforceBookingRateLimit(CALL_NOW_RING_ACTION_RATE_LIMIT, userId, reply)) return;
    const params = parseParamsOr400(ringIdParamsSchema, request, reply);
    if (params === null) return;
    const { ringId } = params;

    try {
      const found = await findRingFor(ringId, userId);
      if (found?.role !== role) {
        sendError(reply, 404, 'ring_not_found');
        return;
      }
      const outcome = await endRing({ ringId, to, actorUserId: userId, now: new Date() });
      const status: CallRingStatus | null = outcome.status;
      reply.code(200).send({ status: status ?? found.ring.status });
    } catch (error) {
      handleUnexpected(reply, error, { ringId, userId, to }, 'Call now ring action failed');
    }
  };
}

async function handleAnswer(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = resolveUserId(request, reply);
  if (userId === null) return;
  if (await enforceBookingRateLimit(CALL_NOW_RING_ACTION_RATE_LIMIT, userId, reply)) return;
  const params = parseParamsOr400(ringIdParamsSchema, request, reply);
  if (params === null) return;
  const { ringId } = params;

  try {
    const result = await answerCallNow({ ringId, userId });
    if (result.ok) {
      sendMemberJoinGrant(reply, result.join);
      return;
    }
    switch (result.code) {
      case 'ring_not_found':
        sendError(reply, 404, result.code);
        return;
      case 'ring_not_ringing':
        sendError(reply, 409, result.code, { status: result.status });
        return;
      case 'join_failed':
        sendJoinError(reply, result.failure, { route: 'call-now-answer', ringId, userId });
        return;
      case 'account_on_hold':
      case 'booking_unfunded':
      case 'booking_reserved':
      case 'booking_funding_unavailable':
        sendFundingRefusal(reply, result.code, result.suggestedTopUpMinor);
        return;
    }
  } catch (error) {
    handleUnexpected(reply, error, { ringId, userId }, 'Call now answer failed');
  }
}

export function callNowRoutes(fastify: FastifyInstance): Promise<void> {
  const preHandler = [requireAuth];
  fastify.get('/cases/:engagementId/call-now', { preHandler }, handleView);
  fastify.post('/cases/:engagementId/call-now', { preHandler }, handleStart);
  fastify.get('/call-now/rings/:ringId', { preHandler }, handleRingRead);
  fastify.post(
    '/call-now/rings/:ringId/decline',
    { preHandler },
    ringActionHandler('callee', 'declined')
  );
  fastify.post(
    '/call-now/rings/:ringId/stop',
    { preHandler },
    ringActionHandler('caller', 'stopped')
  );
  fastify.post('/call-now/rings/:ringId/answer', { preHandler }, handleAnswer);
  return Promise.resolve();
}
