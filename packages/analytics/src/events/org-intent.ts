// ADR-1038 (S2 / BAL-369) "Organizations by Default". Server-only — fired
// post-commit when a typed org is INSTANTIATED at the onboarding Intent step
// (company promote, or agency provision/solo). The class is decided in the web
// post-commit helper (never in the browser). Property keys are snake_case to match
// the codebase convention (signup-domain.ts, party-domains.ts); `distinct_id` is
// required by `trackServer`.
export const ORG_INTENT_SERVER_EVENTS = {
  /** A typed org (company or agency) was created at the onboarding Intent step. */
  CREATED_AT_INTENT: 'org_created_at_intent',
} as const;

export interface OrgIntentServerEventMap {
  [ORG_INTENT_SERVER_EVENTS.CREATED_AT_INTENT]: {
    party_type: 'company' | 'agency';
    domain_class: 'corporate' | 'freemail';
    distinct_id: string;
  };
}
