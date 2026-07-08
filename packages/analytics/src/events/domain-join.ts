// BAL-346 client-side domain-join interstitial + pending events (Scope A —
// client → company only). Fired via `track(...)` from the onboarding company
// step and the pending screen. The server-side match-engine events live in
// `party-join.ts` (BAL-345); these cover only the interactive interstitial the
// user sees. `party_type` is always `'company'` in Scope A (agency → BAL Scope B,
// not built here).
export const DOMAIN_JOIN_EVENTS = {
  INTERSTITIAL_VIEWED: 'domain_join_interstitial_viewed',
  INTERSTITIAL_CONTINUED: 'domain_join_interstitial_continued',
  INTERSTITIAL_OPTED_OUT: 'domain_join_interstitial_opted_out',
  REQUEST_PENDING_VIEWED: 'join_request_pending_viewed',
} as const;

type DomainJoinMode = 'auto' | 'request';

export interface DomainJoinEventMap {
  [DOMAIN_JOIN_EVENTS.INTERSTITIAL_VIEWED]: { mode: DomainJoinMode; party_type: 'company' };
  [DOMAIN_JOIN_EVENTS.INTERSTITIAL_CONTINUED]: { mode: DomainJoinMode; party_type: 'company' };
  [DOMAIN_JOIN_EVENTS.INTERSTITIAL_OPTED_OUT]: { mode: DomainJoinMode; party_type: 'company' };
  [DOMAIN_JOIN_EVENTS.REQUEST_PENDING_VIEWED]: { party_type: 'company' };
}
