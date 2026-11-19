/**
 * BAL-649 — THE POST-COMMIT TELLING FOR CALL NOW RINGS: domain events and analytics.
 *
 * ⚠ NEVER THROWS. Both run after the ring's compare-and-set has committed, so a failure here
 * must change no status code and roll back nothing; it is logged at `warn` and swallowed.
 *
 * Rules attach to `call.ringing` (an SMS when the ring was written `reachedBy: 'sms'`) and to
 * `call.no_answer` (a bell item, plus the delayed missed-call email). `call.declined`,
 * `call.stopped` and `call.connected` have no rule, so the engine logs and drops them.
 */
import { meetingRingsRepository, type MeetingRing } from '@balo/db';
import { CALL_NOW_SERVER_EVENTS, trackServer, type ServerEvents } from '@balo/analytics/server';
import { createLogger } from '@balo/shared/logging';
import {
  ringAnalyticsOutcome,
  type CallNowDisplayReason,
  type CallRingTerminalStatus,
  type CallSide,
} from '@balo/shared/meetings';
import { notificationEvents } from '../../notifications/publisher.js';
import type { CallRingEventPayload } from '../../notifications/events.js';

const log = createLogger('call-now-events');

export type CallRingEvent =
  | 'call.ringing'
  | 'call.no_answer'
  | 'call.declined'
  | 'call.stopped'
  | 'call.connected';

function toPayload(ring: MeetingRing): CallRingEventPayload {
  return {
    correlationId: ring.id,
    ringId: ring.id,
    meetingId: ring.meetingId,
    engagementId: ring.engagementId,
    callerUserId: ring.callerUserId,
    calleeUserId: ring.calleeUserId,
    callerSide: ring.callerSide,
    placement: ring.placement,
    reachedBy: ring.reachedBy,
    expiresAt: ring.expiresAt.toISOString(),
    startedAt: ring.createdAt.toISOString(),
  };
}

/** Publish one ring event. Best-effort: a queue failure is logged, never raised. */
export async function publishCallEvent(event: CallRingEvent, ring: MeetingRing): Promise<void> {
  try {
    await notificationEvents.publish(event, toPayload(ring));
  } catch (error) {
    log.warn(
      {
        event,
        ringId: ring.id,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to publish Call now event — the ring transition already committed'
    );
  }
}

/** The whole seconds a ring lasted, from its start to its terminal status. */
function ringSeconds(ring: MeetingRing): number {
  const endedAt = ring.endedAt ?? ring.updatedAt;
  return Math.round((endedAt.getTime() - ring.createdAt.getTime()) / 1000);
}

type RingEndedProperties = ServerEvents[typeof CALL_NOW_SERVER_EVENTS.RING_ENDED];
type RefusedReason = ServerEvents[typeof CALL_NOW_SERVER_EVENTS.REFUSED]['reason'];

/**
 * This caller's rings to this callee in the rolling 24 hours ending at `ring.createdAt`, the ring
 * itself included, so it is 1-based. `null` when the count cannot be read: the event
 * still sends, with the gap visible, rather than being lost.
 */
async function attemptNumberToday(ring: MeetingRing): Promise<number | null> {
  try {
    return await meetingRingsRepository.countCallerRingsToCallee({
      callerUserId: ring.callerUserId,
      calleeUserId: ring.calleeUserId,
      endingAt: ring.createdAt,
    });
  } catch (error) {
    log.warn(
      { ringId: ring.id, error: error instanceof Error ? error.message : String(error) },
      'Failed to count call_now_ring_ended.attempt_number_today — sending null'
    );
    return null;
  }
}

/**
 * `call_now_ring_ended`, once per ring, from the terminal compare-and-set that won — never from
 * a CAS that lost its race. Never called for a ring that is still `ringing`.
 *
 * ASYNC because `attempt_number_today` is counted here, but it NEVER THROWS: the ring's transition
 * has committed. `ring_seconds` is `endedAt − createdAt`; a `connected` ring stamps `endedAt` with
 * the connect instant, so there it is the time to answer.
 */
export async function trackRingEnded(ring: MeetingRing): Promise<void> {
  if (ring.status === 'ringing') {
    return;
  }
  try {
    const status: CallRingTerminalStatus = ring.status;
    const properties: RingEndedProperties = {
      outcome: ringAnalyticsOutcome(status),
      ring_seconds: ringSeconds(ring),
      caller_lens: ring.callerSide,
      reached_by: ring.reachedBy,
      placement: ring.placement,
      meeting_id: ring.meetingId,
      attempt_id: ring.attemptId,
      callee_presence_at_start: ring.calleeOnlineAtStart === true ? 'online' : 'offline',
      in_place_of_booking: ring.placement === 'in_place',
      attempt_number_today: await attemptNumberToday(ring),
      distinct_id: ring.callerUserId,
    };
    trackServer(CALL_NOW_SERVER_EVENTS.RING_ENDED, properties);
  } catch (error) {
    log.warn(
      { ringId: ring.id, error: error instanceof Error ? error.message : String(error) },
      'Failed to track call_now_ring_ended'
    );
  }
}

/** A refused start the caller was authorized for (never `case_not_found`). */
export interface CallNowRefusal {
  /** The start result's `code`, minus `case_not_found`. */
  code: Exclude<RefusedReason, CallNowDisplayReason>;
  /** The display reason a `call_now_unavailable` carries, when it has one. */
  reason?: CallNowDisplayReason | null;
}

/**
 * `call_now_refused`: the start API refused a caller it had already authorized, so the side is
 * known. `call_now_unavailable` is refined to its display reason (`busy`, `outside_hours`) when
 * it has one. Never throws: a refusal must be answered whatever analytics does.
 */
export function trackCallNowRefused(input: {
  side: CallSide;
  userId: string;
  result: CallNowRefusal;
}): void {
  const { side, userId, result } = input;
  try {
    trackServer(CALL_NOW_SERVER_EVENTS.REFUSED, {
      caller_lens: side,
      reason: result.reason ?? result.code,
      distinct_id: userId,
    });
  } catch (error) {
    log.warn(
      { userId, code: result.code, error: error instanceof Error ? error.message : String(error) },
      'Failed to track call_now_refused'
    );
  }
}
