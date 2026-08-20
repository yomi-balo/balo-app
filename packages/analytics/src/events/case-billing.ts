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

/**
 * Which path finalized the billing (mirrors `@balo/db` `CreditFinalizationPath`; local to stay
 * dep-free).
 *
 * ⚠ THE MIRROR IS COMPILER-CHECKED, NOT DISCIPLINE-CHECKED: `apps/api`'s `finalizeBilling`
 * assigns `session.finalizationPath` straight into this type, so a label added to the pgEnum
 * and NOT added here fails `tsc` in `apps/api` (and ONLY there — `@balo/analytics` typechecks
 * green on its own). BAL-412 added `'presence'` for exactly that reason: the
 * `meeting_presence`-derived settlement with the ADR-1044 §7 15-minute floor.
 *
 * ⚠ NO NEW EVENT CONSTANT IS MINTED HERE (decision D7). Only this payload union widens, so
 * the exact-key-set guards in `case-billing.test.ts` — which assert CONSTANT keys, not payload
 * keys — are unaffected, and none of the re-export allowlists (`events/index.ts`, `types.ts`,
 * `server/index.ts`) needs an edit. This is a server-only family: it must NEVER join the
 * `vi.mock` list in `apps/web/src/test/setup.ts`.
 */
export type CaseBillingFinalizationPath =
  | 'live_capture'
  | 'confirmed'
  | 'disputed'
  | 'auto_confirmed'
  | 'presence';

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
    // ── BAL-412 (ADR-1044 §7). OPTIONAL — present only on a presence-settled session.
    /** Minutes actually delivered, PRE-floor. */
    actual_min?: number;
    /** `true` when the 15-minute minimum is what fixed `duration_min` — how often it binds. */
    floored?: boolean;
    /** ⚠ NOT `outcome` — that key belongs to the PAYMENT outcome on `session_settled` (D7). */
    settlement_outcome?: 'held' | 'no_show_client' | 'missed_call' | 'abandoned_wait';
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
