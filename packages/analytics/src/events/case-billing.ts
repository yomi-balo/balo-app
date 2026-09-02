import type { MoneyBlockLens, MoneyBlockState, MeetingSettlementShape } from '@balo/shared/credit';

/**
 * BAL-399 (ADR-1040 / ADR-1043) — Case consultation billing-slice analytics.
 *
 * ONE client event (`track` on mount of the recap pending fragment) + SERVER events
 * (`trackServer`). Values do NOT share a feature prefix (`case_billing_finalized`,
 * `case_billing_pending_shown`, `case_overdraft_grace_used`, `expert_payout_recorded`,
 * `session_statement_viewed`, `session_statement_downloaded`), so the key-set guard uses the
 * GENERIC snake_case matcher.
 *
 * ⚠ BAL-441 — `distinct_id` is NOT uniformly `companyId` any more. The three original server
 * events (`CASE_BILLING_FINALIZED`, `CASE_OVERDRAFT_GRACE_USED`, `EXPERT_PAYOUT_RECORDED`) carry
 * `distinct_id = companyId` (the natural subject of a company-wallet event). The two BAL-441
 * additions (`SESSION_STATEMENT_VIEWED`, `SESSION_STATEMENT_DOWNLOADED`) are page-VIEW-shaped
 * events by a PERSON — matching `recap_viewed` / `case_surface_viewed` /
 * `engagement_workspace_viewed` — so their `distinct_id` is the viewing user's id.
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

/**
 * BAL-441 — the statement lens. `Exclude`d from the money-block's own union rather than
 * re-spelled, so the type STATES that the admin lens can never reach this surface
 * (`resolveSessionLens` has no admin arm). Same discipline as `RecapContextType`.
 */
export type SessionStatementLens = Exclude<MoneyBlockLens, 'admin'>;

/** BAL-441 — aliased, never re-spelled: this IS the money block's pending/finalized discriminant. */
export type SessionStatementState = MoneyBlockState;

/**
 * BAL-441 — WHERE the reader arrived from.
 *
 * ⚠ TWO VALUES, AND THE ABSENCE OF A THIRD IS THE POINT. `'billing'` is NOT declared: the owner
 * decided against a billing-history list page, so nothing can emit it, and a
 * declared-but-never-emitted dimension reads as a 100% drop-off funnel step in PostHog. The
 * ticket that builds a list page adds the value AND its `?from` whitelist arm together — see
 * `meetings/[meetingId]/page.tsx:29-47`, which states the rule at length. Additive, non-breaking.
 */
export type SessionStatementSource = 'money_block' | 'direct';

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
  /** BAL-441 — a session receipt/payout page rendered for an AUTHORISED viewer. */
  SESSION_STATEMENT_VIEWED: 'session_statement_viewed',
  /** BAL-441 — a statement PDF was successfully rendered and returned. Not the click. */
  SESSION_STATEMENT_DOWNLOADED: 'session_statement_downloaded',
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
  [CASE_BILLING_SERVER_EVENTS.SESSION_STATEMENT_VIEWED]: {
    session_id: string;
    lens: SessionStatementLens;
    source: SessionStatementSource;
    statement_state: SessionStatementState;
    /** Absent on any non-presence session — the payload's own field is optional too. */
    settlement_shape?: MeetingSettlementShape;
    /** The VIEWING USER's id — NOT company_id (see the module docblock's BAL-441 note). */
    distinct_id: string;
  };
  [CASE_BILLING_SERVER_EVENTS.SESSION_STATEMENT_DOWNLOADED]: {
    session_id: string;
    lens: SessionStatementLens;
    /** The VIEWING USER's id — NOT company_id (see the module docblock's BAL-441 note). */
    distinct_id: string;
  };
}
