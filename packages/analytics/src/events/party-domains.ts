// Domain auto-join (BAL-344 / ADR-1031). Server-only — the outcome is decided in
// the capture transaction, never in the browser. Fired by apps/web AFTER the tx
// commits. Property keys are snake_case to match the codebase convention
// (billing.ts, expert-payouts.ts); `distinct_id` is required by `trackServer`.
export const PARTY_DOMAIN_SERVER_EVENTS = {
  CAPTURED: 'party_domain_captured',
  CAPTURE_SKIPPED: 'party_domain_capture_skipped',
  // BAL-347 admin settings surface. ADDED is fired when an admin explicitly adds a
  // domain (source is always 'admin_added' — the signup auto path emits CAPTURED);
  // REMOVED when an admin soft-removes one. Both fire post-commit from the web
  // Server Actions.
  ADDED: 'party_domain_added',
  REMOVED: 'party_domain_removed',
} as const;

export interface PartyDomainServerEventMap {
  [PARTY_DOMAIN_SERVER_EVENTS.CAPTURED]: {
    party_type: 'company' | 'agency';
    source: 'auto_captured' | 'admin_added';
    distinct_id: string;
  };
  [PARTY_DOMAIN_SERVER_EVENTS.CAPTURE_SKIPPED]: {
    reason: 'blocked_domain' | 'already_claimed';
    distinct_id: string;
  };
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
