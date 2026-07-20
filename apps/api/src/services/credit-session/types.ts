/**
 * BAL-378 (ADR-1040 Lane 2) — credit-session service IO types (pure).
 */
import type { CreditSession, CreditSettlementStatus } from '@balo/db';

export interface OpenSessionServiceInput {
  /** The acting member (from auth). The session's company + wallet are resolved from them. */
  initiatingMemberId: string;
  expertProfileId: string;
  estimatedMinutes: number;
}

/** Gate outcomes surfaced as a discriminated union — the route maps codes to 403 / 409. */
export type OpenSessionServiceErrorCode =
  | 'forbidden' // no company membership / lacks CONSUME_CREDITS → 403
  | 'wallet_missing' // the company has no credit wallet → 409 (structural — should not happen)
  | 'account_hold' // an open receivable soft-holds the company → 409
  | 'session_in_progress' // a live session already exists on the wallet → 409 (one live session/wallet)
  | 'settlement_pending' // a prior session's overdraft settlement is still in flight (balance < 0) → 409
  | 'insufficient_no_mandate' // can't fund the estimate and no mandate → 409
  | 'expert_rate_missing'; // the expert has no rate → 409

export type OpenSessionServiceResult =
  | { ok: true; sessionId: string; status: 'pending'; holdId: string | null }
  | { ok: false; code: OpenSessionServiceErrorCode };

/**
 * The actor-vs-session-company authorization outcome shared by the lifecycle handlers
 * (`connect` / `end` / `nudge` / `drawdown-state`). `not_found` → 404, `forbidden` → 403.
 */
export type SessionActorErrorCode = 'not_found' | 'forbidden';

/** `connectSession` outcome — authorize (fail-closed) then pending → active. */
export type ConnectSessionServiceResult =
  | { ok: true; session: CreditSession }
  | { ok: false; code: SessionActorErrorCode };

/** `nudgeAdminForTopup` outcome — authorize (fail-closed) then publish the top-up nudge. */
export type NudgeServiceResult = { ok: true } | { ok: false; code: SessionActorErrorCode };

/**
 * The terminal outcome of `endSession` settlement (drives the `POST /:id/end` response body).
 * CLIENT-facing — it deliberately EXCLUDES `expertAccruedMinor` (the raw pre-markup expert pay),
 * which stays persisted on the session + in the audit row for the payout lane but must never
 * reach the client (leaking it derives the raw expert rate + Balo's markup).
 */
export interface EndSessionServiceResult {
  settlementStatus: CreditSettlementStatus;
  overdraftSettledMinor: number;
  /**
   * BAL-399: `true` when this was an EXTERNAL session that PARKED awaiting a BAL-133 duration
   * confirmation — no settlement ran and the money block stays PENDING until the confirmed
   * duration lands. Absent/false on the live-capture path (which finalizes immediately).
   */
  awaitingDuration?: boolean;
}

/** `endSession` outcome — authorize (fail-closed) then settle. */
export type EndSessionServiceOutcome =
  | { ok: true; result: EndSessionServiceResult }
  | { ok: false; code: SessionActorErrorCode };
