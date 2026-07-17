/**
 * BAL-378 (ADR-1040 Lane 2) in-session drawdown / overdraft analytics.
 *
 * TWO client events (`track` from the in-session components) and FOUR server events
 * (`trackServer` — fired ONLY on the authoritative commit: grace entered / ceiling hit /
 * settlement / receivable, never on an idempotent re-meter replay). Values do NOT share a
 * feature prefix (`session_started`, `low_balance_warning_shown`, `grace_entered`, …), so the
 * key-set guard uses the GENERIC snake_case matcher, not a `session_` prefix regex. Server
 * events carry `distinct_id = companyId` (the natural subject of a company-wallet event).
 */

// ── Client (browser `track`) ──────────────────────────────────────────────
export const SESSION_EVENTS = {
  /** A consultation started (fired on connect success). */
  STARTED: 'session_started',
  /** The in-session low-balance warning card was shown to the member. */
  LOW_BALANCE_WARNING_SHOWN: 'low_balance_warning_shown',
} as const;

export interface SessionEventMap {
  [SESSION_EVENTS.STARTED]: {
    session_id: string;
    expert_profile_id: string;
    rate_per_minute_minor: number;
  };
  [SESSION_EVENTS.LOW_BALANCE_WARNING_SHOWN]: {
    session_id: string;
    minutes_remaining: number;
  };
}

// ── Server (`trackServer`) ────────────────────────────────────────────────
export const SESSION_SERVER_EVENTS = {
  /** The meter moved a session active → card-backed grace. */
  GRACE_ENTERED: 'grace_entered',
  /** Grace hit the overdraft ceiling (vs the 30-min / no-mandate bound) → wrap. */
  GRACE_CEILING_HIT: 'grace_ceiling_hit',
  /** A session settled — success (in-credit or charged), hard fail, or SCA required. */
  SESSION_SETTLED: 'session_settled',
  /** A failed settlement opened a receivable (soft account hold). */
  RECEIVABLE_OPENED: 'receivable_opened',
} as const;

export interface SessionServerEventMap {
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
    outcome: 'success' | 'fail' | 'requires_action';
    overdraft_settled_minor: number;
    /** = company_id. */
    distinct_id: string;
  };
  [SESSION_SERVER_EVENTS.RECEIVABLE_OPENED]: {
    session_id: string;
    company_id: string;
    amount_minor: number;
    reason: string;
    /** = company_id. */
    distinct_id: string;
  };
}
