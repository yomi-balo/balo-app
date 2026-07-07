// Domain auto-join match engine (BAL-345 / ADR-1031). Server-only — every outcome
// is decided in the match engine or a Server Action (never in the browser) and
// fired AFTER the DB tx commits. Property keys are snake_case to match the codebase
// convention (party-domains.ts, billing.ts); `distinct_id` is required by
// `trackServer`.
export const PARTY_JOIN_SERVER_EVENTS = {
  /** A verified corporate domain matched a shareable party (any of the 4 matched outcomes). */
  SIGNUP_DOMAIN_MATCHED: 'party_join_signup_domain_matched',
  /** A new membership was created via `domainJoinMode = 'auto'`. */
  DOMAIN_AUTO_JOIN_COMPLETED: 'party_join_domain_auto_join_completed',
  /** A pending join request was created via `domainJoinMode = 'request'`. */
  REQUEST_CREATED: 'party_join_request_created',
  /** An admin approved a pending join request. */
  REQUEST_APPROVED: 'party_join_request_approved',
  /** An admin declined a pending join request. */
  REQUEST_DECLINED: 'party_join_request_declined',
  /** A user used the escape hatch to leave a domain party (durable opt-out recorded). */
  DOMAIN_JOIN_OPTED_OUT: 'party_join_domain_opted_out',
} as const;

export interface PartyJoinServerEventMap {
  [PARTY_JOIN_SERVER_EVENTS.SIGNUP_DOMAIN_MATCHED]: {
    party_type: 'company' | 'agency';
    mode: 'auto' | 'request';
    distinct_id: string;
  };
  [PARTY_JOIN_SERVER_EVENTS.DOMAIN_AUTO_JOIN_COMPLETED]: {
    party_type: 'company' | 'agency';
    distinct_id: string;
  };
  [PARTY_JOIN_SERVER_EVENTS.REQUEST_CREATED]: {
    party_type: 'company' | 'agency';
    distinct_id: string;
  };
  [PARTY_JOIN_SERVER_EVENTS.REQUEST_APPROVED]: {
    party_type: 'company' | 'agency';
    time_to_resolution_seconds: number;
    distinct_id: string;
  };
  [PARTY_JOIN_SERVER_EVENTS.REQUEST_DECLINED]: {
    party_type: 'company' | 'agency';
    time_to_resolution_seconds: number;
    distinct_id: string;
  };
  [PARTY_JOIN_SERVER_EVENTS.DOMAIN_JOIN_OPTED_OUT]: {
    path: 'auto' | 'request';
    distinct_id: string;
  };
}
