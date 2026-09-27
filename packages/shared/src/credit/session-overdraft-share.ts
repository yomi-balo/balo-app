/**
 * BAL-474 (ADR-1040 Amendment 7 §A) — THE ONE DEFINITION of the figure a session settles:
 * THIS session's share of its wallet's negative balance.
 *
 *   walletNegativeMinor = max(0, −walletBalance)            // read under the wallet lock
 *   overdraftMinor      = min(ownConsumedMinor, walletNegativeMinor)   // THE SHARE
 *   priorDebtLeftMinor  = walletNegativeMinor − overdraftMinor         // older debt it leaves
 *
 * WHY. The wallet's negative balance IS the debt (the receivable is a parallel record). Every
 * credit pays the OLDEST debt first — the convention Amendment 6 §F's coverage anchor already
 * uses — and the settling session is the NEWEST debt on the wallet, because the retained
 * one-live-session-per-wallet gate guarantees no other session is non-terminal. So the newest
 * debt's outstanding amount is its own consumption, capped by what the wallet still owes.
 *
 * THE FOUR PROPERTIES (pinned by `packages/db/src/invariants/a-session-never-settles-debt-it-did-
 * not-incur.test.ts`; property 4 also by its integration sibling):
 *  1. `0 ≤ share ≤ ownConsumed` — A SESSION NEVER SETTLES DEBT IT DID NOT INCUR. This cap is
 *     also what makes every ordering of another session's in-flight charge safe: S can never be
 *     charged for S1's debt, so the two charges can never collect the same money twice.
 *  2. `share ≤ walletNegative` — never more than the wallet owes.
 *  3. IDENTICAL TO THE LEGACY `max(0, −balance)` ON EVERY STATE THE GATED OPEN ALLOWS. Under the
 *     gated open the balance at open is ≥ 0 and no settlement is in flight; the only debit that
 *     is not S's own is `dormancy_expiry`, which zeroes a POSITIVE balance and cannot fire once
 *     S has ticked (every ledger write rolls `expires_at` forward). So `−balance ≤ ownConsumed`.
 *  4. NO DEBT WITHOUT AN OWNER — the repository's terminal writers check, inside the terminal
 *     transaction, that the `priorDebtLeftMinor` this returns is owned by an open receivable or
 *     an uncredited in-flight settlement of ANOTHER session ({@link SessionOverdraftBasis}).
 *
 * THE TRADE-OFF (orchestrator ruling D5.1, stated plainly). A credit that lands DURING S's life
 * while another session's charge is still in flight is not netted off S's charge; it becomes
 * surplus credit once that charge lands. That never double-charges a card and cannot under-bill.
 * The rejected alternative — subtracting in-flight charges counted by the `processing` label —
 * under-billed with no owner whenever the post-charge stamp overwrote a `settled` row.
 *
 * ⚠ BAL-477 PRECONDITION. The "newest debt" premise rests on one live session per wallet. If
 * BAL-477 ever allows concurrent sessions on one wallet it must keep the `ownConsumed` cap and
 * decide attribution between them; this function alone does not.
 *
 * PURE — no I/O, no clock, no env. `ownConsumedMinor` is the gross `session_consume` the session
 * itself posted (there is no reversal of `session_consume`; the ledger is append-only).
 */

export interface SessionOverdraftShareInput {
  /** `credit_wallets.balance_minor`, read under the wallet advisory lock at the terminal. */
  readonly walletBalanceMinor: number;
  /** −Σ this session's own `session_consume` ledger rows. Never negative. */
  readonly ownConsumedMinor: number;
}

export interface SessionOverdraftShare {
  /** THE SETTLED FIGURE — this session's share of the wallet's negative balance. */
  readonly overdraftMinor: number;
  /** `max(0, −walletBalance)` — everything the wallet owes right now. */
  readonly walletNegativeMinor: number;
  /** The session's own gross consumption, as given. */
  readonly ownConsumedMinor: number;
  /** Older debt this session does NOT settle — another owner must account for it. */
  readonly priorDebtLeftMinor: number;
}

/**
 * The share, plus the ownerless-debt reading the terminal transaction took (D7.3). Returned to
 * the service as `overdraftBasis`; `ownerlessPriorDebtMinor > 0` is alarmed post-commit.
 */
export interface SessionOverdraftBasis extends SessionOverdraftShare {
  /**
   * `max(0, priorDebtLeftMinor − Σ amounts owned by OTHER open receivables and OTHER uncredited
   * in-flight settlements)`. Compared in AMOUNTS, not counts: partial top-ups pay debt down
   * without closing receivables, so recorded owners only ever meet or exceed the older debt they
   * own — a shortfall is real.
   */
  readonly ownerlessPriorDebtMinor: number;
}

function assertInteger(name: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new Error(
      `resolveSessionOverdraftShare: ${name} must be an integer (received ${String(value)})`
    );
  }
}

export function resolveSessionOverdraftShare(
  input: SessionOverdraftShareInput
): SessionOverdraftShare {
  assertInteger('walletBalanceMinor', input.walletBalanceMinor);
  assertInteger('ownConsumedMinor', input.ownConsumedMinor);
  if (input.ownConsumedMinor < 0) {
    throw new Error(
      `resolveSessionOverdraftShare: ownConsumedMinor must not be negative (received ${String(input.ownConsumedMinor)})`
    );
  }
  const walletNegativeMinor = Math.max(0, -input.walletBalanceMinor);
  const overdraftMinor = Math.min(input.ownConsumedMinor, walletNegativeMinor);
  return {
    overdraftMinor,
    walletNegativeMinor,
    ownConsumedMinor: input.ownConsumedMinor,
    priorDebtLeftMinor: walletNegativeMinor - overdraftMinor,
  };
}
