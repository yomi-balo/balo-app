// webhook-events.ts
// Type definitions for the Stripe events Balo handles.
// These are the job payloads dispatched to BullMQ from the webhook route.

export type StripeEventJob = {
  eventId: string;       // Stripe event ID — also used as BullMQ jobId for deduplication
  type: StripeEventType;
  data: Record<string, unknown>;
  idempotencyKey: string; // = eventId
};

export type StripeEventType =
  | 'checkout.session.completed'  // → add credits to client
  | 'transfer.paid'               // → mark payout complete
  | 'transfer.failed'             // → reverse payout, re-add credits, notify
  | 'account.updated'             // → sync expert Stripe account status
  | 'charge.refunded'             // → deduct credits from client
  | 'charge.dispute.created';     // → freeze case, alert admin

// Stripe account status (stored on expert_profiles)
export type StripeAccountStatus = {
  stripeConnectId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requiresAction: boolean; // = !detailsSubmitted || !payoutsEnabled
};

// Payout states for the Payouts settings page UI
export type PayoutState =
  | 'not_connected'        // No stripeConnectId
  | 'onboarding_incomplete' // Has stripeConnectId but !detailsSubmitted || !payoutsEnabled
  | 'connected'            // chargesEnabled + payoutsEnabled = true
  | 'issues';              // Stripe flagged a problem (manual review required)
