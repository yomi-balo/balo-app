import type { DrawdownKey } from '@balo/shared/credit';

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
 * ⚠ BAL-466 (D7) — `STARTED` MOVED CLIENT → SERVER. It never fired client-side in production
 * (the only render of `InSessionPanel` types `expertProfileId` as `never`), so there was
 * nothing to "move" behaviourally — the constant simply relocated to `SESSION_SERVER_EVENTS`,
 * fired at the real connect seam (`presence-writer.ts`'s co-presence transition).
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
   * BAL-466 (F7/F8, review fix round) — admission tried to open a `'presence'` credit session
   * and the gate refused, so the consultation proceeds UNBILLED and (for `wallet_busy`) the
   * expert goes UNPAID. Fired ONLY for the two shapes that are a real money-path anomaly, not
   * the ordinary same-meeting join race (that stays `log.info`, no event): a DIFFERENT meeting
   * already holds the company's one-live-session-per-wallet slot (`wallet_busy`, tracked at
   * BAL-477), or the wallet cannot fund the estimate and carries no mandate
   * (`insufficient_no_mandate`, tracked at BAL-474 — which gains the overdraft-tolerant open
   * that will replace this refusal). Deliberately carries NO `session_id` — no row was created.
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
  [SESSION_SERVER_EVENTS.SESSION_OPEN_REFUSED]: {
    meeting_id: string;
    company_id: string;
    /** `null` when the diagnostic wallet lookup itself could not resolve one. */
    wallet_id: string | null;
    reason: 'wallet_busy' | 'insufficient_no_mandate';
    /** = company_id. */
    distinct_id: string;
  };
}
