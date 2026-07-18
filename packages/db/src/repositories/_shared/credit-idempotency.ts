/**
 * State-derived idempotency-key helper (BAL-376 / ADR-1040).
 *
 * PURE — no `db`, no I/O, no `randomUUID`. A discriminated union keyed by `reason`,
 * returning a DETERMINISTIC string so Stripe webhook replays and BullMQ retries
 * collapse to the SAME `credit_ledger.idempotency_key` (which is `NOT NULL UNIQUE`),
 * making a replay a no-op (invariant #4). NEVER return a random value.
 *
 * The driver (a later lane, e.g. the Stripe webhook handler) computes the key from
 * triggering state and passes it into `applyLedgerEntry`. Auto-top-up additionally
 * relies on the per-wallet advisory lock (`applyLedgerEntry` step 1) so two consumes
 * each below threshold serialize and only the first reload commits.
 */
export type IdempotencyKeyInput =
  | { reason: 'manual_purchase'; paymentIntentId: string }
  // The consume that CROSSED the threshold ⇒ exactly one reload per crossing.
  | { reason: 'auto_topup'; walletId: string; triggeringEntryId: string }
  // Exactly one settlement per session.
  | { reason: 'overdraft_settlement'; sessionId: string }
  // Per-minute drawdown tick.
  | { reason: 'session_consume'; sessionId: string; tickSeq: number }
  // One expiry per wallet per sweep date (asOf = YYYY-MM-DD).
  | { reason: 'dormancy_expiry'; walletId: string; asOf: string }
  // One grant per promo per wallet. Keyed on the promo's UUID (NOT the code string): a
  // soft-deleted + re-minted code is a new row with a new id but the same string, so a
  // string key would collide with the old grant — the id key never does.
  | { reason: 'promo'; walletId: string; promoCodeId: string }
  // Admin supplies an explicit idempotency token.
  | { reason: 'adjustment'; token: string };

/**
 * Derive the deterministic `${reason}:${...state}` idempotency key. Exhaustive over
 * `IdempotencyKeyInput` — a new reason is a compile error until handled here.
 */
export function deriveIdempotencyKey(input: IdempotencyKeyInput): string {
  switch (input.reason) {
    case 'manual_purchase':
      return `manual_purchase:${input.paymentIntentId}`;
    case 'auto_topup':
      return `auto_topup:${input.walletId}:${input.triggeringEntryId}`;
    case 'overdraft_settlement':
      return `overdraft_settlement:${input.sessionId}`;
    case 'session_consume':
      return `session_consume:${input.sessionId}:${input.tickSeq}`;
    case 'dormancy_expiry':
      return `dormancy_expiry:${input.walletId}:${input.asOf}`;
    case 'promo':
      return `promo:${input.walletId}:${input.promoCodeId}`;
    case 'adjustment':
      return `adjustment:${input.token}`;
  }
}
