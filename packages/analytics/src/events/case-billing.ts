/**
 * BAL-399 (ADR-1040 / ADR-1043) — Case consultation billing-slice analytics.
 *
 * ONE client event (`track` on mount of the recap pending fragment) + THREE server events
 * (`trackServer`, fired ONCE at `finalizeBilling` on the payout-record `created` guard — never on
 * an idempotent replay). Values do NOT share a feature prefix (`case_billing_finalized`,
 * `case_billing_pending_shown`, `case_overdraft_grace_used`, `expert_payout_recorded`), so the
 * key-set guard uses the GENERIC snake_case matcher. Server events carry `distinct_id = companyId`
 * (the natural subject of a company-wallet event).
 */

/** Which path finalized the billing (mirrors `@balo/db` `CreditFinalizationPath`; local to stay dep-free). */
export type CaseBillingFinalizationPath =
  | 'live_capture'
  | 'confirmed'
  | 'disputed'
  | 'auto_confirmed';

// ── Client (browser `track`) ──────────────────────────────────────────────
export const CASE_BILLING_EVENTS = {
  /** The recap money block rendered in its PENDING (pre-finalize, elapsed-only) state. */
  PENDING_SHOWN: 'case_billing_pending_shown',
} as const;

export interface CaseBillingEventMap {
  [CASE_BILLING_EVENTS.PENDING_SHOWN]: {
    session_id: string;
    elapsed_min: number;
  };
}

// ── Server (`trackServer`) ────────────────────────────────────────────────
export const CASE_BILLING_SERVER_EVENTS = {
  /** The recap-facing finalization signal — fired once at `finalizeBilling` (adds `path`). */
  CASE_BILLING_FINALIZED: 'case_billing_finalized',
  /** Finalization-time per-session grace summary — fired ONLY when the session used grace. */
  CASE_OVERDRAFT_GRACE_USED: 'case_overdraft_grace_used',
  /** The expert payout obligation was booked (once per session). */
  EXPERT_PAYOUT_RECORDED: 'expert_payout_recorded',
} as const;

export interface CaseBillingServerEventMap {
  [CASE_BILLING_SERVER_EVENTS.CASE_BILLING_FINALIZED]: {
    session_id: string;
    company_id: string;
    amount_aud_minor: number;
    duration_min: number;
    path: CaseBillingFinalizationPath;
    /** = company_id. */
    distinct_id: string;
  };
  [CASE_BILLING_SERVER_EVENTS.CASE_OVERDRAFT_GRACE_USED]: {
    session_id: string;
    company_id: string;
    overdraft_settled_minor: number;
    grace_minutes: number;
    /** = company_id. */
    distinct_id: string;
  };
  [CASE_BILLING_SERVER_EVENTS.EXPERT_PAYOUT_RECORDED]: {
    payout_record_id: string;
    expert_profile_id: string;
    session_id: string;
    amount_aud_minor: number;
    duration_min: number;
    path: CaseBillingFinalizationPath;
    /** = company_id. */
    distinct_id: string;
  };
}
