/**
 * BAL-649 (ADR-1058) — STARTING A RING.
 *
 * ── SEQUENCE ───────────────────────────────────────────────────────────────────────────────
 *   1. `authorizeCallNow`                       → `case_not_found`
 *   2. an EXPERT caller sending `inPlaceOfMeetingId` → `in_place_not_allowed` (a 400: an expert
 *      always rings on a NEW meeting, decision 9 — the field is not theirs to send)
 *   3. a ring past `expires_at` still blocks the case's one-ringing slot, so end it first
 *      (`endRing('unanswered')`); a live one is left for the gates to refuse
 *   4. `loadCallNowGates` → the shared predicate  → `call_now_unavailable`
 *   5. placement: a CLIENT caller may opt in to ringing a same-day booking IN PLACE
 *   6. a CLIENT caller's `new_meeting` ring runs the booking funding check over the 15-minute window
 *      (ADR-1040 Amendment 8 §B) → `account_on_hold` / `booking_unfunded` / `booking_reserved` /
 *      `booking_funding_unavailable`. It runs BEFORE the meeting row exists, so the call never
 *      reserves against its own check, and BEFORE `meterCallee`, so a refusal spends no callee
 *      budget and writes nothing. An in-place ring (the client's own same-day booking is already
 *      reserved) and an expert caller (the client commits later, in `answerCallNow`) run no check
 *   7. `meterCallee` — the per-(CALLEE, calling party) ring budget, metered only once the ring is
 *      otherwise allowed, so a refused attempt never spends a callee's budget → `rate_limited`
 *   8. the repository write (one transaction; the one-ringing partial unique index raises
 *      `MeetingRingAlreadyLiveError` for two racing starts)
 *   9. `new_meeting` only, after commit: availability rebuild, then the Daily room. A room that
 *      cannot be provisioned cannot be answered, so the ring is stopped and the start fails. The
 *      callee was never shown that ring, so it is not a ring the caller made: it announces
 *      nothing, emits no `call_now_ring_ended`, and gives its callee slot back (`releaseCallee`)
 *  10. the expiry job (best-effort — the lifecycle sweep is the backstop), then `call.ringing`
 *
 * ⚠⚠ DELIBERATELY NOT HERE: calendar projection, calendar invites, `booking.confirmed`. A Call now
 * meeting is a call in progress, not a booking.
 *
 * ⚠ THE `refusal` NEVER LEAVES THE API. The route answers only the display `reason`, so the
 * wire is not an oracle for why a person is unavailable.
 */
import {
  MeetingRingAlreadyLiveError,
  meetingRingsRepository,
  type MeetingRing,
  type StartRingInput,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  CALL_NOW_SCHEDULED_MINUTES,
  isRingLive,
  type CallNowDisplayReason,
  type CallNowRefusal,
  type CallRingPlacement,
} from '@balo/shared/meetings';
import type { FastifyBaseLogger } from 'fastify';
import { resolveCallNowRingWindows, ringExpiresAt } from '../../config/call-now-timers.js';
import { enqueueCallNowRingExpiry } from '../../jobs/call-now-ring-expiry.js';
import {
  checkCaseBookingFunding,
  type CaseBookingFundingCode,
} from '../meetings/case-booking-funding.js';
import { provisionCallNowVenue } from '../meetings/provision-meeting.js';
import { authorizeCallNow } from './authorize-call-now.js';
import type { CalleePresence } from './callee-presence.js';
import { publishCallEvent } from './call-now-events.js';
import { loadCallNowGates } from './call-now-gates.js';
import { endRing } from './end-ring.js';
import { rebuildAvailabilityBestEffort } from './post-commit.js';

const log = createLogger('call-now-start');

const MS_PER_MINUTE = 60_000;

export type StartCallNowResult =
  | { ok: true; ringId: string; meetingId: string; placement: CallRingPlacement; expiresAt: Date }
  | {
      ok: false;
      code:
        | 'case_not_found'
        | 'in_place_not_allowed'
        | 'in_place_not_eligible'
        | 'venue_unavailable';
    }
  /** The callee's ring budget is spent; `meterCallee` has ALREADY sent the reply. */
  | { ok: false; code: 'rate_limited' }
  /**
   * The client's funding check refused the ring (nothing was metered or written). The figure is the
   * client's all-in top-up, `null` when none is meaningful.
   */
  | { ok: false; code: CaseBookingFundingCode; suggestedTopUpMinor: number | null }
  | {
      ok: false;
      code: 'call_now_unavailable';
      refusal: CallNowRefusal | 'ring_in_progress';
      reason: CallNowDisplayReason | null;
    };

/**
 * The party a ring is placed on behalf of: the case's company for a client caller, the case's
 * delivering expert profile for an expert caller (whoever on the agency side places it).
 */
export interface CallNowCallingParty {
  readonly kind: 'company' | 'expert_profile';
  readonly id: string;
}

export interface StartCallNowInput {
  engagementId: string;
  userId: string;
  inPlaceOfMeetingId?: string;
  now?: Date;
  log: FastifyBaseLogger;
  /**
   * The per-(callee, calling party) ring budget, supplied by the route (the rate-limit factory).
   * Resolves `true` when the ring is refused — and the reply has then already been sent.
   */
  meterCallee: (calleeUserId: string, callingParty: CallNowCallingParty) => Promise<boolean>;
  /** Gives back the slot `meterCallee` spent, for a ring the callee was never shown. Never throws. */
  releaseCallee: (calleeUserId: string, callingParty: CallNowCallingParty) => Promise<void>;
  deps?: {
    presence?: CalleePresence;
    provision?: typeof provisionCallNowVenue;
  };
}

/** The meeting a ring will sit on, or a refusal. */
type PlacementChoice =
  | { ok: true; placement: 'new_meeting' }
  | { ok: true; placement: 'in_place'; meetingId: string }
  | { ok: false; code: 'in_place_not_eligible' };

function choosePlacement(input: {
  requestedMeetingId: string | undefined;
  candidate: { meetingId: string } | null;
}): PlacementChoice {
  const { requestedMeetingId, candidate } = input;
  if (requestedMeetingId === undefined) {
    return { ok: true, placement: 'new_meeting' };
  }
  if (candidate?.meetingId !== requestedMeetingId) {
    return { ok: false, code: 'in_place_not_eligible' };
  }
  return { ok: true, placement: 'in_place', meetingId: candidate.meetingId };
}

/** Clear a ring whose window has closed but which nothing ended yet. */
async function endStaleRing(engagementId: string, now: Date): Promise<void> {
  const ringing = await meetingRingsRepository.findRingingForEngagement(engagementId);
  if (ringing !== undefined && !isRingLive(ringing, now)) {
    await endRing({ ringId: ringing.id, to: 'unanswered', actorUserId: null, now });
  }
}

const RING_IN_PROGRESS: StartCallNowResult = {
  ok: false,
  code: 'call_now_unavailable',
  refusal: 'ring_in_progress',
  reason: null,
};

type WriteRingResult =
  | { ok: true; ring: MeetingRing; meetingId: string }
  | { ok: false; result: StartCallNowResult };

interface WriteRingInput {
  placement: Exclude<PlacementChoice, { ok: false }>;
  ringInput: StartRingInput;
  now: Date;
  log: FastifyBaseLogger;
  provision: typeof provisionCallNowVenue;
  /** Gives the callee slot back when the ring is stopped before the callee is shown it. */
  releaseCallee: () => Promise<void>;
}

/** The ring write, and for a new meeting the room it needs. Every refusal is a typed result. */
async function writeRing(input: WriteRingInput): Promise<WriteRingResult> {
  const { placement, ringInput, now } = input;
  try {
    if (placement.placement === 'in_place') {
      const started = await meetingRingsRepository.startOnMeeting({
        ...ringInput,
        meetingId: placement.meetingId,
      });
      if (started === undefined) {
        return { ok: false, result: { ok: false, code: 'in_place_not_eligible' } };
      }
      return { ok: true, ring: started.ring, meetingId: started.meeting.id };
    }

    const started = await meetingRingsRepository.startWithNewMeeting({
      ...ringInput,
      scheduledStart: now,
      scheduledEnd: new Date(now.getTime() + CALL_NOW_SCHEDULED_MINUTES * MS_PER_MINUTE),
    });
    await rebuildAvailabilityBestEffort(started.expertProfileId, log);
    const venue = await input.provision(started.meeting, input.log);
    if (!venue.provisioned) {
      log.warn(
        { ringId: started.ring.id, meetingId: started.meeting.id },
        'Call now ring stopped before it was shown — its room could not be provisioned'
      );
      await endRing({
        ringId: started.ring.id,
        to: 'stopped',
        actorUserId: null,
        now: new Date(),
        announce: false,
      });
      await input.releaseCallee();
      return { ok: false, result: { ok: false, code: 'venue_unavailable' } };
    }
    return { ok: true, ring: started.ring, meetingId: started.meeting.id };
  } catch (error) {
    if (error instanceof MeetingRingAlreadyLiveError) {
      return { ok: false, result: RING_IN_PROGRESS };
    }
    throw error;
  }
}

export async function startCallNow(input: StartCallNowInput): Promise<StartCallNowResult> {
  const { engagementId, userId } = input;
  const now = input.now ?? new Date();
  const provision = input.deps?.provision ?? provisionCallNowVenue;

  const authorized = await authorizeCallNow({ engagementId, userId });
  if (!authorized.ok) {
    return { ok: false, code: 'case_not_found' };
  }
  const { side, caseRow, mayRing } = authorized;
  if (side === 'expert' && input.inPlaceOfMeetingId !== undefined) {
    return { ok: false, code: 'in_place_not_allowed' };
  }

  await endStaleRing(engagementId, now);

  const gates = await loadCallNowGates({
    caseRow,
    side,
    userId,
    mayRing,
    now,
    presence: input.deps?.presence,
  });
  if (!gates.availability.canCallNow) {
    return {
      ok: false,
      code: 'call_now_unavailable',
      refusal: gates.availability.refusal,
      reason: gates.availability.reason,
    };
  }
  if (gates.callee === null) {
    // Unreachable while `calleeResolved` gates the predicate; narrows the type for what follows.
    return {
      ok: false,
      code: 'call_now_unavailable',
      refusal: 'callee_unavailable',
      reason: null,
    };
  }

  const placement = choosePlacement({
    requestedMeetingId: input.inPlaceOfMeetingId,
    candidate: gates.inPlaceCandidate,
  });
  if (!placement.ok) {
    return { ok: false, code: placement.code };
  }

  if (side === 'client' && placement.placement === 'new_meeting') {
    const funding = await checkCaseBookingFunding({
      companyId: caseRow.companyId,
      expertProfileId: caseRow.expertProfileId,
      scheduledStart: now,
      scheduledEnd: new Date(now.getTime() + CALL_NOW_SCHEDULED_MINUTES * MS_PER_MINUTE),
      now,
    });
    if (!funding.ok) {
      log.info({ engagementId, userId, code: funding.code }, 'Call now start refused — funding');
      return { ok: false, code: funding.code, suggestedTopUpMinor: funding.suggestedTopUpMinor };
    }
  }

  const callingParty: CallNowCallingParty =
    side === 'client'
      ? { kind: 'company', id: caseRow.companyId }
      : { kind: 'expert_profile', id: caseRow.expertProfileId };
  if (await input.meterCallee(gates.callee.userId, callingParty)) {
    return { ok: false, code: 'rate_limited' };
  }

  const expiresAt = ringExpiresAt(now, 'app', resolveCallNowRingWindows());
  const callee = gates.callee;
  const written = await writeRing({
    placement,
    ringInput: {
      engagementId,
      callerUserId: userId,
      calleeUserId: gates.callee.userId,
      callerSide: side,
      reachedBy: 'app',
      expiresAt,
    },
    now,
    log: input.log,
    provision,
    releaseCallee: () => input.releaseCallee(callee.userId, callingParty),
  });
  if (!written.ok) {
    return written.result;
  }
  const { ring, meetingId } = written;

  try {
    await enqueueCallNowRingExpiry(ring.id, expiresAt, now);
  } catch (error) {
    log.warn(
      {
        ringId: ring.id,
        error: error instanceof Error ? error.message : String(error),
      },
      'Call now ring expiry could not be enqueued — the lifecycle sweep will end the ring'
    );
  }

  await publishCallEvent('call.ringing', ring);
  log.info(
    {
      ringId: ring.id,
      meetingId,
      engagementId,
      placement: ring.placement,
      callerSide: side,
    },
    'Call now ring started'
  );

  return { ok: true, ringId: ring.id, meetingId, placement: ring.placement, expiresAt };
}
