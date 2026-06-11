/**
 * The non-negotiable Balo standard terms shown on every proposal. Hoisted out of
 * the composer's payment-terms tab so the composer (authoring) and the read-only
 * proposal document (client review, BAL-289) share one source of truth.
 */
export const STANDARD_TERMS = [
  'Work is delivered against the milestones and scope set out in this proposal.',
  'Invoices are issued via Balo; payment is held and released through the platform.',
  'Either party may raise a dispute through Balo support before final acceptance.',
  'Confidential information shared during the engagement stays confidential.',
];
