/**
 * BAL-649 / ADR-1058 — Call now analytics.
 *
 * Two families live here, and they must never cross:
 *
 * - `CALL_NOW_SERVER_EVENTS` is SERVER-ONLY. The ring's terminal compare-and-set runs in
 *   `apps/api`, and the outcome is a fact the server decided; no browser code emits it. It MUST
 *   NOT be added to `AllEvents` (the client union) or to the `apps/web/src/test/setup.mocks.ts`
 *   client analytics mock. It joins `ServerEvents` and is exported from `server/index.ts`
 *   (`apps/api` imports from `@balo/analytics/server` ONLY).
 * - `CALL_NOW_EVENTS` (BAL-650) is the CLIENT family for the Call now funding gate. It joins
 *   `AllEvents` and the client barrels, never `ServerEvents`.
 *
 * ⚠ REGISTRATION IS FIVE FILES per family: this one, `events/index.ts`, `types.ts`, the matching
 * barrel (`server/index.ts` or `client/index.ts`), and the guard test.
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

/** `call_now_funding_gate_shown.reason`: why the gate stopped the call. */
export type CallNowFundingGateReason = 'account_on_hold' | 'insufficient' | 'reserved_by_upcoming';

/**
 * `call_now_funding_gate_resolved.via`: how the gate ended. On an expert's call the ring is left to
 * lapse while the client tops up, so `top_up` there means "topped up, then called back".
 */
export type CallNowFundingGateResolution = 'top_up' | 'booking_in_place' | 'abandoned';

export const CALL_NOW_EVENTS = {
  /** The funding gate was shown to a client who started or answered a call. */
  FUNDING_GATE_SHOWN: 'call_now_funding_gate_shown',
  /** The funding gate ended: the client topped up, switched to calling in place, or left. */
  FUNDING_GATE_RESOLVED: 'call_now_funding_gate_resolved',
} as const;

export interface CallNowEventMap {
  [CALL_NOW_EVENTS.FUNDING_GATE_SHOWN]: {
    /** The side that placed the call. */
    caller_lens: CallSide;
    reason: CallNowFundingGateReason;
  };
  [CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED]: {
    via: CallNowFundingGateResolution;
  };
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
