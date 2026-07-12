// Domain admin settings surface (BAL-347 / ADR-1031). Server-only — the outcome is
// decided in the write transaction, never in the browser. Fired by apps/web AFTER
// the tx commits. Property keys are snake_case to match the codebase convention
// (billing.ts, expert-payouts.ts); `distinct_id` is required by `trackServer`.
//
// BAL-369 / ADR-1038 retired the signup-time CAPTURED / CAPTURE_SKIPPED events —
// signup no longer claims a corporate domain (the claim + org promotion moved to
// the onboarding Intent step, tracked by `org_created_at_intent`). Only the admin
// add/remove path remains.
export const PARTY_DOMAIN_SERVER_EVENTS = {
  // ADDED is fired when an admin explicitly adds a domain (source is always
  // 'admin_added'); REMOVED when an admin soft-removes one. Both fire post-commit
  // from the web Server Actions.
  ADDED: 'party_domain_added',
  REMOVED: 'party_domain_removed',
} as const;

export interface PartyDomainServerEventMap {
  [PARTY_DOMAIN_SERVER_EVENTS.ADDED]: {
    party_type: 'company' | 'agency';
    source: 'admin_added';
    distinct_id: string;
  };
  [PARTY_DOMAIN_SERVER_EVENTS.REMOVED]: {
    party_type: 'company' | 'agency';
    distinct_id: string;
  };
}
