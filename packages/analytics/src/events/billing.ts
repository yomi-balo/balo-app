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
}
