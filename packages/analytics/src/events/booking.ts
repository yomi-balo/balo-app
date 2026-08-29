/**
 * BAL-400 — case-booking flow analytics. ALL are CLIENT events (`track`); there is no
 * `BOOKING_SERVER_EVENTS` (D4c: no rate anywhere, and the money path is out of scope — D1).
 *
 * ⚠ REGISTRATION IS SIX FILES FOR A CLIENT FAMILY, NOT CLAUDE.md's THREE (memory
 * `reference_analytics_registration_is_five_files`, and this family needs one more than that):
 *   1. this file
 *   2. `packages/analytics/src/events/index.ts` — re-export
 *   3. `packages/analytics/src/types.ts` — `& BookingEventMap` on `AllEvents`
 *   4. `packages/analytics/src/client/index.ts` — re-export (else `apps/web` cannot import it)
 *   5. `apps/web/src/lib/analytics/index.ts` — re-export in the web client barrel
 *   6. `apps/web/src/test/setup.ts` — the `vi.mock('@/lib/analytics', …)` export list, else
 *      every booking component test throws on an undefined constant
 */

export const BOOKING_EVENTS = {
  FLOW_OPENED: 'booking_flow_opened',
  CONFIRM_VIEWED: 'booking_confirm_viewed',
  CASE_CHOICE_SHOWN: 'booking_case_choice_shown',
  ATTACHED_TO_CASE: 'booking_attached_to_case',
  COMPANY_SELECTION_SHOWN: 'booking_company_selection_shown',
  GUESTS_INVITED: 'booking_guests_invited',
  /**
   * ⚠ NOT `booking_case_booked` — `case_booked` is the funnel's terminal event and reads as a
   * noun-first outcome, matching the design's own naming rather than the
   * `{feature}_{noun}_{past_tense_verb}` convention the other seven follow.
   */
  CASE_BOOKED: 'case_booked',
  ABANDONED: 'booking_abandoned',
  /** BAL-409 — fired from `reschedule-dialog.tsx` after the Server Action returns `ok`. */
  RESCHEDULED: 'booking_rescheduled',
  /** BAL-410 — fired from `cancel-consultation-dialog.tsx` after the Server Action returns `ok`. */
  CANCELLED: 'booking_cancelled',
  /** BAL-410 — the dialog was opened and dismissed without a successful cancel. */
  CANCEL_ABANDONED: 'booking_cancel_abandoned',
  /** BAL-411 — the expert published a proposal. Fired from the propose dialog on `ok`. */
  RESCHEDULE_PROPOSED: 'reschedule_proposed',
  /**
   * BAL-411 — the proposal reached a terminal state by SOMEONE'S ACTION (accept / decline /
   * withdraw). ⚠ NO `'expired'` outcome — see `deriveRescheduleProposalState`'s docblock:
   * expiry is derived in PostHog as `reschedule_proposed` minus a matching answer, never fired
   * as its own event.
   */
  RESCHEDULE_PROPOSAL_ANSWERED: 'reschedule_proposal_answered',
  /** BAL-411 — the accepted option was gone at re-validation (409 `window_not_available`). */
  RESCHEDULE_PROPOSAL_SLOT_LOST: 'reschedule_proposal_slot_lost',
} as const;

/** BAL-411 — who answered a reschedule proposal. Deliberately excludes `'expired'` (lazy, never fired). */
export type RescheduleProposalOutcome = 'accepted' | 'declined' | 'withdrawn';

/** Where the booking wrapper was opened from (D4a's four entry points, minus "book again" being its own source). */
export type BookingSource = 'profile' | 'search' | 'case_quick_pick' | 'book_again';

/** Whether the confirm step renders the case chooser or a FIXED case (D4a #3). */
export type BookingEntryMode = 'chooser' | 'fixed_case';

/** Where the wrapper was when it closed without completing a booking. */
export type BookingAbandonStep = 'pick_time' | 'confirm' | 'error';

export interface BookingEventMap {
  [BOOKING_EVENTS.FLOW_OPENED]: {
    expert_id: string;
    source: BookingSource;
  };
  [BOOKING_EVENTS.CONFIRM_VIEWED]: {
    expert_id: string;
    entry_mode: BookingEntryMode;
  };
  [BOOKING_EVENTS.CASE_CHOICE_SHOWN]: {
    open_case_count: number;
  };
  [BOOKING_EVENTS.ATTACHED_TO_CASE]: {
    existing_consultation_count: number;
  };
  [BOOKING_EVENTS.COMPANY_SELECTION_SHOWN]: {
    eligible_count: number;
  };
  [BOOKING_EVENTS.GUESTS_INVITED]: {
    count: number;
    /**
     * ⚠ A CLIENT-SIDE ESTIMATE for funnel purposes only. The AUTHORITATIVE `access_scope` is
     * computed and stored by `inviteGuests` at invite time (ADR-1038) — this property never
     * gates anything, it only annotates the funnel.
     */
    same_domain_count: number;
  };
  [BOOKING_EVENTS.CASE_BOOKED]: {
    expert_id: string;
    duration_minutes: number;
    products_count: number;
    has_description: boolean;
    guest_count: number;
    is_new_case: boolean;
    provisioned: boolean;
  };
  [BOOKING_EVENTS.ABANDONED]: {
    expert_id: string;
    step: BookingAbandonStep;
  };
  [BOOKING_EVENTS.RESCHEDULED]: {
    /** `'client'` (BAL-409, client-initiated) or `'expert'` (BAL-411, accept of a proposal). */
    initiated_by: 'client' | 'expert';
    hours_before_start: number;
  };
  [BOOKING_EVENTS.CANCELLED]: {
    /**
     * WHICH AXIS AUTHORIZED IT — taken verbatim from the API's `initiatedBy`, never re-derived
     * client-side, so the funnel and the audit row cannot disagree about who cancelled.
     */
    initiated_by: 'client' | 'expert' | 'admin';
    /**
     * ⚠⚠ THE v2-CUTOFF DECISION INPUT — the ticket says so in as many words: "`hours_before_start`
     * IS THE NUMBER THAT DECIDES WHETHER v2 NEEDS A CUTOFF". Notice given: `now` → the meeting's
     * EXISTING `scheduledStart`, computed exactly as `reschedule-dialog.tsx` does for
     * `booking_rescheduled`.
     *
     * ⚠ IT CAN BE NEGATIVE, AND A NEGATIVE IS NOT BAD DATA. `resolveCancelRefusal` reads no clock
     * (BAL-410 D5), so a `scheduled` meeting whose start has passed but which NOBODY JOINED is
     * still cancellable. A negative value means "cancelled after the scheduled start, with no
     * presence" — which is the honest outcome there, because with no presence there is no
     * no-show to settle. The cutoff analysis must treat it that way rather than filtering it out.
     */
    hours_before_start: number;
  };
  /** ⚠ NO PROPERTIES, per the ticket. Opened the dialog, backed out — nothing else is known. */
  [BOOKING_EVENTS.CANCEL_ABANDONED]: Record<string, never>;
  [BOOKING_EVENTS.RESCHEDULE_PROPOSED]: {
    proposal_id: string;
    /** 1–3 — `RESCHEDULE_PROPOSAL_MAX_OPTIONS` in `@balo/shared/meetings`. */
    option_count: number;
    hours_before_start: number;
  };
  [BOOKING_EVENTS.RESCHEDULE_PROPOSAL_ANSWERED]: {
    proposal_id: string;
    outcome: RescheduleProposalOutcome;
    hours_to_respond: number;
    option_count: number;
  };
  [BOOKING_EVENTS.RESCHEDULE_PROPOSAL_SLOT_LOST]: {
    proposal_id: string;
    option_count: number;
  };
}
