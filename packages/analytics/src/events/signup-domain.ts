// ADR-1038 (S1 / BAL-368) "Organizations by Default". Server-only — the class is
// decided in the web post-commit helper (never in the browser) and fired ONCE per
// signup AFTER the create tx commits. Property keys are snake_case to match the
// codebase convention (party-domains.ts, billing.ts); `distinct_id` is required by
// `trackServer`.
export const SIGNUP_DOMAIN_SERVER_EVENTS = {
  /** A new signup's email domain was typed corporate vs freemail (no org, no claim yet). */
  CLASSIFIED: 'signup_domain_classified',
} as const;

/** The 2-way domain class dimension. String-compatible with `@balo/shared` DomainClass. */
export type SignupDomainClass = 'corporate' | 'freemail';

export interface SignupDomainServerEventMap {
  [SIGNUP_DOMAIN_SERVER_EVENTS.CLASSIFIED]: {
    domain_class: SignupDomainClass;
    distinct_id: string;
  };
}
