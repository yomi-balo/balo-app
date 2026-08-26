/**
 * BAL-378 (ADR-1040 Lane 2) — credit-session service IO types (pure).
 */
import type { CreditDurationSource, CreditSession, CreditSettlementStatus } from '@balo/db';
import type { EligibleCompany } from '@balo/shared/credit';

export interface OpenSessionServiceInput {
  /** The acting member (from auth). The session's wallet is resolved from the chosen company. */
  initiatingMemberId: string;
  expertProfileId: string;
  estimatedMinutes: number;
  /**
   * BAL-401 — the billing company to draw down. CAPABILITY-GATED, NOT an arbitrary wallet id:
   * `openSession` only honours a company the caller holds `CONSUME_CREDITS` on (fail-closed IDOR
   * guard). Omit it and the service auto-selects when exactly one company is eligible, or returns
   * `company_selection_required` when more than one is.
   */
  companyId?: string;
  /**
   * BAL-129 (D5) — the Balo meeting this session bills. OPTIONAL.
   *
   * ⚠ SUPERSEDED CLAIM, CORRECTED: this used to say "nothing sends it yet (BAL-400 wires it
   * when it books a Case consultation)". BAL-400 (booking) was the recorded intent and is NOT
   * the seam — **BAL-466** sends it from `joinMeetingAsMember`'s `openCaseSessionBestEffort`,
   * at ADMISSION, alongside `durationSource: 'presence'` (see the bidirectional coherence guard
   * below, G1). A `duration_source = 'external'` session still legitimately has an engagement
   * and NO Balo meeting.
   *
   * ⚠ THE CLIENT NEVER SENDS `engagementId`, AND THAT IS THE WHOLE POINT.
   * `OpenSessionInput`'s docblock states the coherence obligation — `engagementId` must be
   * the engagement reachable from `meetingId` via `meeting_contexts`, and
   * `companyId`/`expertProfileId` must be that engagement's parties — and concedes that
   * nothing in the repository can check it (the predicate is cross-table and cannot be a
   * CHECK, an FK, or by house style a repository gate). The only way to make a DIVERGENT
   * PAIR UNCONSTRUCTIBLE is to make it underivable from client input: ONE resolution, ONE
   * source. `openSession` derives `engagementId` from this id, server-side.
   */
  meetingId?: string;
  /**
   * BAL-466 (D4) — HOW THIS SESSION'S BILLABLE DURATION WILL BE ESTABLISHED. Omitted ⇒
   * `'live_capture'`, exactly what every pre-BAL-466 caller gets.
   *
   * ⚠⚠ IT IS A **SERVICE** INPUT, NOT A WIRE FIELD, AND IT MUST STAY THAT WAY. See
   * `routes/sessions/schema.ts` — `openSessionBodySchema` deliberately does NOT accept it.
   * Provenance decides which settlement engine owns the money; a client that could choose it
   * could open a `'presence'` session with no meeting, which `findPresenceUnsettled` can never
   * select (it requires `meeting_id IS NOT NULL`) — an unsettleable row with a live hold.
   *
   * ⚠ `'presence'` REQUIRES `meetingId`. Enforced in `openSession`, because the predicate is
   * cross-field policy and the repository deliberately does not gate
   * (`OpenSessionInput`'s docblock, `credit-sessions.ts:256-262`, assigns this obligation to
   * BAL-466 by name).
   *
   * ⚠ F13 — NARROWED to the two provenances a service caller may actually select. `'external'`
   * belongs to externally-captured meetings (BAL-133) and is never chosen at open time by any
   * caller in this codebase; admitting it here would make a third, unused value representable at
   * a seam whose only coherence guard (`open-session.ts`) constrains `'presence'` alone.
   */
  durationSource?: Extract<CreditDurationSource, 'live_capture' | 'presence'>;
}

/** Gate outcomes surfaced as a discriminated union — the route maps codes to 403 / 409. */
export type OpenSessionServiceErrorCode =
  | 'forbidden' // no company membership / lacks CONSUME_CREDITS → 403
  | 'wallet_missing' // the company has no credit wallet → 409 (structural — should not happen)
  | 'account_hold' // an open receivable soft-holds the company → 409
  | 'session_in_progress' // a live session already exists on the wallet → 409 (one live session/wallet)
  | 'settlement_pending' // a prior session's overdraft settlement is still in flight (balance < 0) → 409
  | 'insufficient_no_mandate' // can't fund the estimate and no mandate → 409
  | 'expert_rate_missing' // the expert has no rate → 409
  /**
   * BAL-129 (D5) — the supplied `meetingId` does not resolve to a Case engagement this
   * caller may bill → 409.
   *
   * ⚠ ONE LITERAL FOR ALL SIX FAILURE SHAPES (meeting missing/soft-deleted, zero `case`
   * contexts, >1 `case` context, engagement missing, company mismatch, expert mismatch).
   * Distinguishing them would tell a caller whether a guessed uuid EXISTS — the same reason
   * `authorize-session-actor` collapses to `not_found`/`forbidden`. Which shape it was goes
   * to the LOG, not the wire.
   *
   * ⚠ 409, NOT 403, DELIBERATELY: reusing `forbidden` would conflate a meeting-coherence
   * failure with the membership gate, and the two want different client behaviour. The
   * existing `openErrorStatus` already maps everything except `forbidden` to 409, so this
   * needs no change there.
   */
  | 'meeting_not_bookable';

export type OpenSessionServiceResult =
  | { ok: true; sessionId: string; status: 'pending'; holdId: string | null }
  // BAL-401 — >1 eligible billing company and none chosen: the actor must pick one. Carries a
  // NARROW eligible-company list (id/name/logoUrl only). Deliberately NOT an
  // `OpenSessionServiceErrorCode` so `openErrorStatus` never has to consider `companies`.
  | { ok: false; code: 'company_selection_required'; companies: EligibleCompany[] }
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
