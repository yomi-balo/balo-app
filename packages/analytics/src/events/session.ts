import type {
  CreditSessionOpenedByLabel,
  DebtCoveringCreditReason,
  DrawdownKey,
} from '@balo/shared/credit';

/**
 * BAL-378 (ADR-1040 Lane 2) in-session drawdown / overdraft analytics.
 *
 * THREE client events (`track` from the in-session components) and FIVE server events
 * (`trackServer` — fired ONLY on the authoritative commit: connect / grace entered / ceiling
 * hit / settlement / receivable, never on an idempotent re-meter replay). Values do NOT share a
 * feature prefix (`session_started`, `low_balance_warning_shown`, `grace_entered`, …), so the
 * key-set guard uses the GENERIC snake_case matcher, not a `session_` prefix regex. Server
 * events carry `distinct_id = companyId` (the natural subject of a company-wallet event).
 *
 * ⚠ `SESSION_STARTED` IS A SERVER EVENT. The only render of `InSessionPanel` types `expertProfileId` as
 * `never`, so a client-side start never fired in production. It lives in `SESSION_SERVER_EVENTS` and fires at
 * the real connect seam (`start-billing.ts`, BAL-474 Rule A — called by the presence writer and the meter
 * sweep), once per session, for the caller that performed `pending → active`.
 *
 * ⚠⚠ BAL-403 ADDED `IN_SESSION_PANEL_VIEWED` AND `NUDGE_CLICKED` — the in-call BALANCE drawer's
 * impression and its one interaction. Both fire from `components/balo/credit/`, OUTSIDE the
 * `meeting-call-no-lens-gate.test.ts` scanned trees, which is why `IN_SESSION_PANEL_VIEWED`'s
 * `lens` property is expressible here: it is a copy-selection dimension, not an authorization
 * gate — see that file's in-call wiring for the full reasoning.
 */

// ── Client (browser `track`) ──────────────────────────────────────────────
export const SESSION_EVENTS = {
  /** The in-session low-balance warning card was shown to the member. */
  LOW_BALANCE_WARNING_SHOWN: 'low_balance_warning_shown',
  /**
   * BAL-403 — the in-call BALANCE drawer mounted (an impression, per open — the drawer unmounts
   * on close, so THIS is per-open, unlike the two lifecycle events above which the embedded
   * variant suppresses in favour of this one).
   */
  IN_SESSION_PANEL_VIEWED: 'in_session_panel_viewed',
  /** BAL-403 — the member clicked the in-call nudge CTA. Fires on click, before the await. */
  NUDGE_CLICKED: 'session_nudge_clicked',
} as const;

export interface SessionEventMap {
  [SESSION_EVENTS.LOW_BALANCE_WARNING_SHOWN]: {
    session_id: string;
    minutes_remaining: number;
  };
  [SESSION_EVENTS.IN_SESSION_PANEL_VIEWED]: {
    session_id: string;
    /** ⚠ COPY SELECTION, NEVER AUTHORIZATION — see the module docblock. */
    lens: 'client' | 'member';
    state: DrawdownKey;
  };
  [SESSION_EVENTS.NUDGE_CLICKED]: {
    session_id: string;
  };
}

// ── Server (`trackServer`) ────────────────────────────────────────────────
export const SESSION_SERVER_EVENTS = {
  /**
   * BAL-466 (D7) — a consultation CONNECTED: an expert and a client side are both in the room
   * and the meter's anchor was stamped. ⚠ FIRED SERVER-SIDE, at `presence-writer.ts`'s
   * co-presence transition, which is compare-and-set — so exactly once per meeting. The client
   * constant that used to carry this value was structurally unreachable and was removed with
   * this change; there is ONE producer.
   */
  SESSION_STARTED: 'session_started',
  /** The meter moved a session active → card-backed grace. */
  GRACE_ENTERED: 'grace_entered',
  /** Grace hit the overdraft ceiling (vs the 30-min / no-mandate bound) → wrap. */
  GRACE_CEILING_HIT: 'grace_ceiling_hit',
  /** A session settled — success (in-credit or charged), hard fail, or SCA required. */
  SESSION_SETTLED: 'session_settled',
  /** A failed settlement opened a receivable (soft account hold). */
  RECEIVABLE_OPENED: 'receivable_opened',
  /**
   * BAL-535 (ADR-1040 Amendment 6 §F) — a cash-funded credit (`manual_purchase` / `auto_topup`)
   * returned the wallet to a non-negative balance and cleared every open receivable on it,
   * releasing the company's soft account hold. Paired with `RECEIVABLE_OPENED` above — together
   * they answer "how many holds clear without ops touching them" (§J's measurement claim).
   */
  RECEIVABLE_CLEARED: 'receivable_cleared',
  /**
   * BAL-466 (F7/F8, review fix round; widened by G5) — the presence seam tried to OPEN a
   * `'presence'` credit session and it was refused. ⚠ BAL-474 (ADR-1040 Amendment 7 §D) REWROTE
   * WHAT THIS MEANS: the seam's open is now overdraft-tolerant, so `insufficient_no_mandate`,
   * `account_hold` and `settlement_pending` are no longer refusals at all, and a refusal at
   * ADMISSION is unbilled only when the terminal path cannot recover it — `recovered_by_terminal_path`
   * says which. Fired from ADMISSION (client member / guest) and from the TERMINAL PATH (a system
   * open on behalf of the booker, or the durability backstop's `retry_exhausted`). Deliberately
   * carries NO `session_id` — no row was created.
   */
  SESSION_OPEN_REFUSED: 'session_open_refused',
} as const;

export interface SessionServerEventMap {
  [SESSION_SERVER_EVENTS.SESSION_STARTED]: {
    session_id: string;
    meeting_id: string;
    expert_profile_id: string;
    /** ⚠ THE MARKED-UP CLIENT RATE. Never the expert rate, never the fee bps. */
    rate_per_minute_minor: number;
    /** = company_id. */
    distinct_id: string;
  };
  [SESSION_SERVER_EVENTS.GRACE_ENTERED]: {
    session_id: string;
    company_id: string;
    wallet_id: string;
    ceiling_room_minor: number;
    /** = company_id. */
    distinct_id: string;
  };
  [SESSION_SERVER_EVENTS.GRACE_CEILING_HIT]: {
    session_id: string;
    company_id: string;
    wallet_id: string;
    overdraft_minor: number;
    /** = company_id. */
    distinct_id: string;
  };
  [SESSION_SERVER_EVENTS.SESSION_SETTLED]: {
    session_id: string;
    company_id: string;
    /** ⚠ THE PAYMENT outcome (D7) — do NOT overload with the settlement shape below. */
    outcome: 'success' | 'fail' | 'requires_action';
    overdraft_settled_minor: number;
    /**
     * BAL-474 (ADR-1040 Amendment 7 §C) — who opened the session. Required: it separates a
     * member's own admission from the on-behalf opens (`guest`, `system`), which is the signal
     * D3's guest-admission billing and the no-show system open exist to recover.
     */
    opened_by: CreditSessionOpenedByLabel;
    /** = company_id. */
    distinct_id: string;
    // ── BAL-412 (ADR-1044 §7). OPTIONAL, present only on a presence-settled session. A
    // SEPARATELY-NAMED key from `outcome` above (D7) — that key is already taken by the
    // payment outcome.
    settlement_outcome?: 'held' | 'no_show_client' | 'missed_call' | 'abandoned_wait';
  };
  [SESSION_SERVER_EVENTS.RECEIVABLE_OPENED]: {
    session_id: string;
    company_id: string;
    amount_minor: number;
    reason: string;
    /** = company_id. */
    distinct_id: string;
  };
  [SESSION_SERVER_EVENTS.RECEIVABLE_CLEARED]: {
    company_id: string;
    wallet_id: string;
    /**
     * How many open receivables this ONE clear operation discharged. There is no `session_id`
     * here on purpose (fix round N4): a wallet can hold several open receivables and the clear
     * is wallet-wide, so the event is per OPERATION — its pair `RECEIVABLE_OPENED` stays per
     * session, and §J's "how many holds clear without ops touching them" sums this count.
     */
    receivable_count: number;
    /** Sum of the cleared receivables' recorded amounts (AUD minor). */
    cleared_minor: number;
    balance_after_minor: number;
    /**
     * How it was covered — DERIVED from `DEBT_COVERING_CREDIT_REASONS` (BAL-474: a cash top-up or
     * a session's own settlement charge), or `'coverage_heal'` (a covered-but-held wallet whose
     * clear had not run was healed under the wallet lock). Never a restated union.
     */
    cleared_by: DebtCoveringCreditReason | 'coverage_heal';
    /** = company_id. */
    distinct_id: string;
  };
  [SESSION_SERVER_EVENTS.SESSION_OPEN_REFUSED]: {
    meeting_id: string;
    /** `null` when the terminal path could not even resolve the meeting's billing company. */
    company_id: string | null;
    /** `null` when the diagnostic wallet lookup itself could not resolve one. */
    wallet_id: string | null;
    /**
     * ⚠ BAL-474 — the reason set after the overdraft-tolerant open: `insufficient_no_mandate`,
     * `account_hold` and `settlement_pending` are GONE (the presence seam tolerates all three),
     * and `booker_unattributable` / `retry_exhausted` are new (the terminal path's own refusals).
     * `company_selection_required` stays deliberately NOT a member (structurally unreachable).
     */
    reason:
      | 'wallet_busy'
      | 'expert_rate_missing'
      | 'wallet_missing'
      | 'forbidden'
      | 'meeting_not_bookable'
      | 'booker_unattributable'
      | 'retry_exhausted';
    /** BAL-474 — who tried to open it: a member's admission, a guest's, or the terminal path. */
    opened_by: CreditSessionOpenedByLabel;
    /**
     * BAL-474 (D7.6) — `true` when the reason is one the terminal path recovers (it opens and
     * settles the session at meeting end), so the consultation is NOT unbilled; `false` for the
     * reasons it cannot recover and for the terminal path's own post-hoc refusals.
     */
    recovered_by_terminal_path: boolean;
    /** = company_id, or meeting_id when the company is null (the refusal named no company). */
    distinct_id: string;
  };
}
