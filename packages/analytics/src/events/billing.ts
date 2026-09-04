// Client billing-details capture (BAL-323). Two events answer two business
// questions: how long after acceptance clients provide billing details, and how
// often the owner/admin role gate blocks the person who wants to proceed.

// -- Client events (fire from browser) -----------------------------------------------
export const BILLING_EVENTS = {
  // A non-owner/admin member viewed the capture step and saw the "an owner/admin
  // must complete this" notice. Answers whether the role gate is real friction.
  DETAILS_BLOCKED_VIEW: 'billing_details_blocked_view',
} as const;

export interface BillingEventMap {
  [BILLING_EVENTS.DETAILS_BLOCKED_VIEW]: {
    company_id: string;
    request_id: string;
  };
}

// -- Server events (fire from Server Actions via trackServer) -------------------------
export const BILLING_SERVER_EVENTS = {
  // The company's billing details were submitted (first-time or edit). Props are
  // computed server-side, so this fires from the submit action, not the browser.
  DETAILS_SUBMITTED: 'billing_details_submitted',
  /** BAL-522 — the company's billing email was captured from the first purchaser. */
  EMAIL_SEEDED: 'billing_email_seeded',
  /** BAL-522 — an explicit change from /settings/billing (never the seed). */
  EMAIL_UPDATED: 'billing_email_updated',
} as const;

export interface BillingServerEventMap {
  [BILLING_SERVER_EVENTS.DETAILS_SUBMITTED]: {
    company_id: string;
    request_id: string;
    country_code: string;
    /** True on the very first capture for the company; false on a later edit. */
    is_first_time: boolean;
    /** Whole hours between proposal acceptance and this submission. */
    hours_since_acceptance: number;
    distinct_id: string;
  };
  [BILLING_SERVER_EVENTS.EMAIL_SEEDED]: {
    company_id: string;
    /** Answers business question (b): the personal-vs-company split of seeds. */
    company_is_personal: boolean;
    distinct_id: string;
  };
  [BILLING_SERVER_EVENTS.EMAIL_UPDATED]: {
    company_id: string;
    company_is_personal: boolean;
    /** `null` when the company had no billing email at all (set before any Stripe touch). */
    previous_source: 'seeded' | 'set' | null;
    /** Whole days between the previous write and this one; `null` when there was none. */
    days_since_set: number | null;
    distinct_id: string;
  };
}
