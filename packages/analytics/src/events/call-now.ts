/**
 * BAL-649 / ADR-1058 — Call now analytics.
 *
 * SERVER-ONLY. The ring's terminal compare-and-set runs in `apps/api`, and the outcome is a
 * fact the server decided; no browser code emits it. It MUST NOT be added to `AllEvents` (the
 * client union) or to the `apps/web/src/test/setup.mocks.ts` client analytics mock.
 *
 * ⚠ REGISTRATION IS FIVE FILES: this one, `events/index.ts`, `types.ts` (`ServerEvents`),
 * `server/index.ts` (`apps/api` imports from `@balo/analytics/server` ONLY), and the guard test.
 *
 * ⚠ NO PII. Ids, one closed enum per dimension and a duration — no names, no company, no
 * address. `distinct_id` is the CALLER's user id.
 */

import type {
  CallRingPlacement,
  CallRingReach,
  CallSide,
  CallSmsSuppressReason,
} from '@balo/shared/meetings';

export const CALL_NOW_SERVER_EVENTS = {
  /**
   * A ring reached a terminal status. Fires ONCE per ring, from the ring's terminal
   * compare-and-set, never from a CAS that lost its race.
   */
  RING_ENDED: 'call_now_ring_ended',
  /** The ring SMS was accepted for delivery. Fires from the SMS adapter, once per sent SMS. */
  SMS_SENT: 'call_sms_sent',
  /**
   * A ring was written as `app` because the SMS was suppressed for a reason. Fires once, after
   * the ring row is written, never for a start that was refused.
   */
  SMS_SUPPRESSED: 'call_sms_suppressed',
} as const;

/** `call_now_ring_ended.outcome`. An unanswered ring is reported as `no_answer`. */
export type CallNowRingOutcome = 'connected' | 'no_answer' | 'declined' | 'stopped';

/** The properties both SMS events share. `audience` is the side the SMS went to, the callee's. */
export interface CallNowSmsEventProperties {
  audience: CallSide;
  ring_id: string;
  /** The CALLER's user id. */
  distinct_id: string;
}

export interface CallNowServerEventMap {
  [CALL_NOW_SERVER_EVENTS.RING_ENDED]: {
    outcome: CallNowRingOutcome;
    /** Whole seconds from the ring starting to its terminal status. */
    ring_seconds: number;
    /** The side that placed the call. */
    caller_lens: CallSide;
    /** How the callee was reached: the app alone, or the app and an SMS. */
    reached_by: CallRingReach;
    placement: CallRingPlacement;
    meeting_id: string;
    /** The CALLER's user id. */
    distinct_id: string;
  };
  [CALL_NOW_SERVER_EVENTS.SMS_SENT]: CallNowSmsEventProperties;
  [CALL_NOW_SERVER_EVENTS.SMS_SUPPRESSED]: CallNowSmsEventProperties & {
    reason: CallSmsSuppressReason;
  };
}
