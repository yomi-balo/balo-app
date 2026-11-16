/**
 * BAL-649 — THE POST-COMMIT TELLING FOR CALL NOW RINGS: domain events and analytics.
 *
 * ⚠ NEVER THROWS. Both run after the ring's compare-and-set has committed, so a failure here
 * must change no status code and roll back nothing; it is logged at `warn` and swallowed.
 *
 * ⚠ NO RULES EXIST FOR THESE EVENTS YET (BAL-652/653 add them), so the notification engine logs
 * and drops each one. Publishing now is what lets those tickets attach recipients and channels
 * without touching this ticket's call sites.
 */
import type { MeetingRing } from '@balo/db';
import { CALL_NOW_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import { createLogger } from '@balo/shared/logging';
import { ringAnalyticsOutcome, type CallRingTerminalStatus } from '@balo/shared/meetings';
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

/**
 * `call_now_ring_ended`, once per ring, from the terminal compare-and-set that won — never from
 * a CAS that lost its race. Never called for a ring that is still `ringing`.
 */
export function trackRingEnded(ring: MeetingRing): void {
  if (ring.status === 'ringing') {
    return;
  }
  try {
    const status: CallRingTerminalStatus = ring.status;
    trackServer(CALL_NOW_SERVER_EVENTS.RING_ENDED, {
      outcome: ringAnalyticsOutcome(status),
      ring_seconds: ringSeconds(ring),
      caller_lens: ring.callerSide,
      reached_by: ring.reachedBy,
      placement: ring.placement,
      meeting_id: ring.meetingId,
      distinct_id: ring.callerUserId,
    });
  } catch (error) {
    log.warn(
      { ringId: ring.id, error: error instanceof Error ? error.message : String(error) },
      'Failed to track call_now_ring_ended'
    );
  }
}
