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
 * - `CALL_NOW_EVENTS` is the CLIENT family: the funding gate (BAL-650) and the caller's funnel
 *   from the tap to the ring (BAL-651). It joins `AllEvents` and the client barrels, never
 *   `ServerEvents`.
 *
 * ⚠ REGISTRATION IS FIVE FILES per family: this one, `events/index.ts`, `types.ts`, the matching
 * barrel (`server/index.ts` or `client/index.ts`), and the guard test.
 *
 * ⚠ NO PII, NO MONEY. Ids, one closed enum per dimension, counts and a duration — no names, no
 * company, no address, no rate. `distinct_id` is the CALLER's user id.
 *
 * BAL-651 — every caller funnel event carries `attempt_id`, a uuid the web client mints on the
 * tap that opens the confirm. The start request carries it to the ring row, so
 * `call_now_ring_ended` joins the funnel to the outcome.
 */

import type {
  CallNowDisplayReason,
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
  /**
   * BAL-651 — the start-call API refused a caller it had already authorized, so the caller's
   * side is known. Never fires for `case_not_found` or the route's pre-auth limiter.
   */
  REFUSED: 'call_now_refused',
} as const;

/** `call_now_ring_ended.outcome`. An unanswered ring is reported as `no_answer`. */
export type CallNowRingOutcome = 'connected' | 'no_answer' | 'declined' | 'stopped';

/**
 * `call_now_refused.reason`: the start-call API's own refusal codes, flattened into one
 * vocabulary. `call_now_unavailable` is refined to its display reason (`busy`, `outside_hours`)
 * when it carries one. The last four are the client funding check's codes.
 */
export type CallNowRefusedReason =
  | CallNowDisplayReason
  | 'call_now_unavailable'
  | 'in_place_not_allowed'
  | 'in_place_not_eligible'
  | 'venue_unavailable'
  | 'rate_limited'
  | 'account_on_hold'
  | 'booking_unfunded'
  | 'booking_reserved'
  | 'booking_funding_unavailable';

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
  /** BAL-651 — the tap that opens the confirm. Mints the attempt's `attempt_id`. */
  CLICKED: 'call_now_clicked',
  /** BAL-651 — the caller committed from the confirm. Fires on the click, before the start result. */
  CONFIRMED: 'call_now_confirmed',
  /** BAL-651 — the caller left the attempt before it connected. */
  ABANDONED: 'call_now_abandoned',
  /** BAL-651 — the caller chose to book a time instead of calling. */
  BOOK_INSTEAD_CLICKED: 'call_now_book_instead_clicked',
} as const;

/**
 * Whether the callee was online when the caller looked, from the loader's presence flag — never a
 * hard-coded value. A client's presence is never exposed to an expert, so the expert arm's flag is
 * `false` by construction and reports `offline`.
 */
export type CallNowPresence = 'online' | 'offline';

/** Which layout the caller was on when they acted. */
export type CallNowSurface = 'desktop' | 'mobile';

/** Where an abandoned attempt stopped. */
export type CallNowAbandonStep = 'confirm' | 'funding' | 'calling';

/** The properties every caller funnel event carries. */
interface CallNowAttemptProperties {
  attempt_id: string;
  /** The caller's side. */
  lens: CallSide;
  surface: CallNowSurface;
}

export interface CallNowEventMap {
  [CALL_NOW_EVENTS.FUNDING_GATE_SHOWN]: {
    /** The side that placed the call. */
    caller_lens: CallSide;
    reason: CallNowFundingGateReason;
  };
  [CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED]: {
    via: CallNowFundingGateResolution;
  };
  [CALL_NOW_EVENTS.CLICKED]: CallNowAttemptProperties & {
    callee_presence: CallNowPresence;
    /**
     * A consultation is already booked today, so "in place of" is on offer. Always `false` on the
     * expert lens, by construction: the expert's confirm never offers "in place of".
     */
    has_booking_today: boolean;
    /** `missed_call_back` is the missed-call notice's call back (BAL-653); nothing sends it yet. */
    entry: 'party_card' | 'missed_call_back';
  };
  [CALL_NOW_EVENTS.CONFIRMED]: CallNowAttemptProperties & {
    callee_presence: CallNowPresence;
    /** `call_anyway` is the commit from the offline confirm. */
    choice: 'call_now' | 'call_anyway';
    in_place_of_booking: boolean;
  };
  [CALL_NOW_EVENTS.ABANDONED]: CallNowAttemptProperties & {
    callee_presence: CallNowPresence;
    step: CallNowAbandonStep;
    via: 'not_now' | 'close' | 'stop_calling';
  };
  [CALL_NOW_EVENTS.BOOK_INSTEAD_CLICKED]: CallNowAttemptProperties & {
    /** `no_answer` covers every ended ring that did not connect, declined included. */
    from: 'confirm_offline' | 'no_answer';
  };
}

export interface CallNowServerEventMap {
  [CALL_NOW_SERVER_EVENTS.RING_ENDED]: {
    outcome: CallNowRingOutcome;
    /**
     * Whole seconds from the ring starting to its terminal status. On `connected`, that is the
     * time to answer.
     */
    ring_seconds: number;
    /** The side that placed the call. */
    caller_lens: CallSide;
    /** How the callee was reached: the app alone, or the app and an SMS. */
    reached_by: CallRingReach;
    placement: CallRingPlacement;
    meeting_id: string;
    /** BAL-651 — the web attempt this ring belongs to; `null` when the start carried none. */
    attempt_id: string | null;
    /**
     * BAL-651 — the callee's presence when the ring started, as the server saw it: UNMASKED, even
     * on an expert's call where the expert's own UI showed `offline`. Server analytics only.
     */
    callee_presence_at_start: CallNowPresence;
    /** BAL-651 — the ring rode a booking already in place today (`placement = 'in_place'`). */
    in_place_of_booking: boolean;
    /**
     * BAL-651 — 1-based: this caller's rings to this callee from the start of the ring's UTC day
     * up to and including this ring, whatever their status or case. The day is the UTC day, not
     * the caller's local one. `null` when the count could not be read; the event still sends.
     */
    attempt_number_today: number | null;
    /** The CALLER's user id. */
    distinct_id: string;
  };
  [CALL_NOW_SERVER_EVENTS.SMS_SENT]: CallNowSmsEventProperties;
  [CALL_NOW_SERVER_EVENTS.SMS_SUPPRESSED]: CallNowSmsEventProperties & {
    reason: CallSmsSuppressReason;
  };
  [CALL_NOW_SERVER_EVENTS.REFUSED]: {
    /** The side that tried to call. */
    caller_lens: CallSide;
    reason: CallNowRefusedReason;
    /** The CALLER's user id. */
    distinct_id: string;
  };
}
