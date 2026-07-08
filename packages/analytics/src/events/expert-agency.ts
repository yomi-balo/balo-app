// BAL-356 / ADR-1034 — expert → agency resolution (apply wizard step 2). Fired via
// `track(...)` from the client `StepAgency` component AFTER the authoritative write
// succeeds (skipped on the idempotent `already_linked` resume). One determined
// outcome per resolution: JOIN an existing agency, PROVISION a new one (signer =
// owner), or SOLO (independent agency-of-one). The `solo` outcome is analytics-only
// — the UI never surfaces the word "agency" to a solo expert.
export const EXPERT_AGENCY_EVENTS = {
  RESOLVED: 'expert_agency_resolved',
} as const;

/** The three determined resolution outcomes tracked on a successful write. */
export type ExpertAgencyOutcome = 'join' | 'provision' | 'solo';

export interface ExpertAgencyEventMap {
  [EXPERT_AGENCY_EVENTS.RESOLVED]: { outcome: ExpertAgencyOutcome };
}
