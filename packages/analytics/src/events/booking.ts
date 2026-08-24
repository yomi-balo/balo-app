/**
 * BAL-400 — case-booking flow analytics. ALL EIGHT are CLIENT events (`track`); there is no
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
} as const;

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
    /** `'client'` today; BAL-411 adds `'expert'`. */
    initiated_by: 'client';
    hours_before_start: number;
  };
}
