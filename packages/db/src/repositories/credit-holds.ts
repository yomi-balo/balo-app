import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  creditHolds,
  creditLedger,
  creditWallets,
  type CreditHold,
  type CreditHoldStatus,
  type NewCreditHold,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/**
 * ⚠ TWO "AVAILABLE" FIGURES LIVE IN THIS FILE, AND THEY ANSWER DIFFERENT QUESTIONS (BAL-474):
 *
 *   · GROSS — `balance − Σ active holds` ({@link creditHoldsRepository.getAvailableBalance}, and
 *     `open()`'s own in-transaction `activeHoldsSum` in `credit-sessions.ts`). A hold reserves a
 *     session's full estimate; this is the admission-time figure, and admission's gate is untouched.
 *   · NETTED — `balance − Σ max(0, hold − that session's posted session_consume)`
 *     ({@link creditHoldsRepository.getAvailableForBooking}). During a LIVE session the balance
 *     already reflects every posted tick while its hold still reserves the full estimate, so the
 *     gross figure subtracts the drawn minutes TWICE. The Case booking funding checks (BAL-478's
 *     balance arm and the D6.5 reservation) read the netted figure so a company's own live call is
 *     subtracted once (ADR-1040 Amendment 7 §H, D8.5).
 */

/**
 * `SUM(amount_minor)` over a wallet's ACTIVE, non-deleted holds — the single correct
 * active-holds sum, shared by `sumActiveByWallet` and `getAvailableBalance` so the two
 * can never drift. Rides `credit_holds_wallet_active_idx`; settled/released/soft-deleted
 * holds are excluded. Returns 0 when the wallet has no active holds.
 *
 * ⚠ BAL-474 — TAKES AN EXECUTOR. It used to read on the bare `db` even when its caller held a
 * transaction, which put the holds sum on a SECOND pooled connection outside the caller's
 * snapshot (V1-F2). Defaults to `db`, so existing callers are unchanged.
 */
async function sumActiveHolds(walletId: string, exec: DbExecutor = db): Promise<number> {
  const [row] = await exec
    .select({ sum: sql<string>`coalesce(sum(${creditHolds.amountMinor}), 0)` })
    .from(creditHolds)
    .where(
      and(
        eq(creditHolds.walletId, walletId),
        eq(creditHolds.status, 'active'),
        isNull(creditHolds.deletedAt)
      )
    );
  return Number(row?.sum ?? 0);
}

/**
 * BAL-474 (D8.5, V1-F4) — `Σ max(0, hold − consumed)` over a wallet's ACTIVE, non-deleted holds,
 * where `consumed` is the gross `session_consume` the hold's own session has already posted. One
 * row per hold (a LEFT JOIN, so a hold whose session has posted nothing — or that is not yet
 * linked to a session — counts in full), clamped per hold so an overrun past its estimate counts
 * 0, never negative. Rides `credit_holds_wallet_active_idx` and `credit_ledger_session_idx`.
 */
async function sumActiveHoldsNetOfConsumption(walletId: string, exec: DbExecutor): Promise<number> {
  const rows = await exec
    .select({
      amountMinor: creditHolds.amountMinor,
      consumedMinor: sql<string>`coalesce(-sum(${creditLedger.amountMinor}), 0)`,
    })
    .from(creditHolds)
    .leftJoin(
      creditLedger,
      and(
        eq(creditLedger.sessionId, creditHolds.sessionId),
        eq(creditLedger.walletId, creditHolds.walletId),
        eq(creditLedger.reason, 'session_consume')
      )
    )
    .where(
      and(
        eq(creditHolds.walletId, walletId),
        eq(creditHolds.status, 'active'),
        isNull(creditHolds.deletedAt)
      )
    )
    .groupBy(creditHolds.id, creditHolds.amountMinor);
  return rows.reduce(
    (sum, row) => sum + Math.max(0, row.amountMinor - Number(row.consumedMinor)),
    0
  );
}

/** The wallet's cached balance on the given executor, or `undefined` when there is no wallet. */
async function readBalance(walletId: string, exec: DbExecutor): Promise<number | undefined> {
  const [wallet] = await exec
    .select({ balanceMinor: creditWallets.balanceMinor })
    .from(creditWallets)
    .where(eq(creditWallets.id, walletId))
    .limit(1);
  return wallet?.balanceMinor;
}

/** Thrown when settle/release is attempted on a non-`active` (already-resolved) hold. */
export class InvalidHoldTransitionError extends Error {
  constructor(
    public readonly from: CreditHoldStatus,
    public readonly to: CreditHoldStatus
  ) {
    super(`Invalid credit hold transition: ${from} → ${to}`);
    this.name = 'InvalidHoldTransitionError';
  }
}

/**
 * Resolve an `active` hold to a terminal status under a row lock, on the given executor.
 * Guards: missing hold → `Error`; non-`active` current status → `InvalidHoldTransitionError`
 * (no double settle/release). When `memberId` is provided, records the RESOLVING member (the
 * last actor) on `member_id`. Assumes the executor is a transaction (the `FOR UPDATE` row
 * lock only spans a statement outside one) — the public wrappers self-wrap when called
 * standalone.
 */
async function resolveHoldOn(
  exec: DbExecutor,
  holdId: string,
  to: Extract<CreditHoldStatus, 'settled' | 'released'>,
  opts: { memberId?: string | null }
): Promise<CreditHold> {
  const [current] = await exec
    .select()
    .from(creditHolds)
    .where(and(eq(creditHolds.id, holdId), isNull(creditHolds.deletedAt)))
    .for('update');
  if (current === undefined) {
    throw new Error(`Credit hold not found: ${holdId}`);
  }
  if (current.status !== 'active') {
    throw new InvalidHoldTransitionError(current.status, to);
  }

  const set: Partial<NewCreditHold> = { status: to, resolvedAt: new Date() };
  if (opts.memberId !== undefined) {
    set.memberId = opts.memberId;
  }

  const [updated] = await exec
    .update(creditHolds)
    .set(set)
    .where(eq(creditHolds.id, holdId))
    .returning();
  if (updated === undefined) {
    throw new Error(`Failed to resolve credit hold: ${holdId}`);
  }
  return updated;
}

/**
 * Resolve a hold, composing under the caller's transaction when `exec` is supplied (so the
 * release/settle commits or rolls back WITH the session `end`/`cancel`) or self-wrapping in
 * `db.transaction` for a standalone call (so the `FOR UPDATE` row lock is held across the
 * select + update).
 */
async function resolveHold(
  holdId: string,
  to: Extract<CreditHoldStatus, 'settled' | 'released'>,
  opts: { memberId?: string | null; exec?: DbExecutor }
): Promise<CreditHold> {
  const { exec, ...resolveOpts } = opts;
  if (exec !== undefined) {
    return resolveHoldOn(exec, holdId, to, resolveOpts);
  }
  return db.transaction((tx) => resolveHoldOn(tx, holdId, to, resolveOpts));
}

export const creditHoldsRepository = {
  /**
   * Place an `active` reservation. A hold moves NO money and takes NO advisory lock of its
   * own. TX-COMPOSABLE (BAL-378): pass `exec` (the caller's `tx`) so the hold is placed
   * INSIDE the session `open` gate txn, under the wallet advisory lock that txn already
   * holds — the reservation then commits or rolls back atomically with the session insert.
   * Defaults to the base `db` for standalone callers. Raw FK violation (23503) on an
   * unknown wallet / session; CHECK (23514) on a non-positive `amountMinor`.
   */
  async place(
    input: {
      walletId: string;
      sessionId?: string | null;
      memberId?: string | null;
      amountMinor: number;
    },
    exec: DbExecutor = db
  ): Promise<CreditHold> {
    const [row] = await exec
      .insert(creditHolds)
      .values({
        walletId: input.walletId,
        sessionId: input.sessionId ?? null,
        memberId: input.memberId ?? null,
        amountMinor: input.amountMinor,
      })
      .returning();
    if (row === undefined) {
      throw new Error('Failed to place credit hold');
    }
    return row;
  },

  /**
   * Settle a hold (active → settled). Guarded: only from `active`. TX-COMPOSABLE — pass
   * `opts.exec` to resolve within the caller's txn; omit it to self-wrap.
   */
  async settle(
    holdId: string,
    opts: { memberId?: string | null; exec?: DbExecutor } = {}
  ): Promise<CreditHold> {
    return resolveHold(holdId, 'settled', opts);
  },

  /**
   * Release a hold (active → released). Guarded: only from `active`. TX-COMPOSABLE — pass
   * `opts.exec` to resolve within the caller's txn (e.g. session `end`/`cancel`); omit it
   * to self-wrap.
   */
  async release(
    holdId: string,
    opts: { memberId?: string | null; exec?: DbExecutor } = {}
  ): Promise<CreditHold> {
    return resolveHold(holdId, 'released', opts);
  },

  /**
   * `SUM(amount_minor)` over the wallet's ACTIVE, non-deleted holds (rides
   * `credit_holds_wallet_active_idx`). Settled/released/soft-deleted holds do not count.
   */
  async sumActiveByWallet(walletId: string): Promise<number> {
    return sumActiveHolds(walletId);
  },

  /**
   * Available balance = `balance_minor − Σ active holds` (invariant #5) — computed on
   * read, NEVER persisted (there is deliberately no `available_minor` column). Reuses the
   * same `sumActiveHolds` path as `sumActiveByWallet`, so the subtracted figure can never
   * diverge from it. Returns 0 when the wallet does not exist.
   *
   * ADVISORY, NOT ATOMIC. These are two separate reads, so the figure can be momentarily stale
   * under concurrent hold/ledger writes. Safe for display and soft pre-checks only. A
   * money-gating lane (BAL-377+) MUST NOT treat this as an authoritative funds gate:
   * re-derive available balance inside its own `db.transaction` AFTER `acquireWalletLock`,
   * where the per-wallet advisory lock serializes it against every other wallet writer.
   *
   * ⚠ BAL-474 — `exec` defaults to `db` (existing callers are unchanged). Passed a transaction,
   * BOTH reads — the balance AND the holds sum — run on it; the holds sum used to read on the
   * bare `db` regardless.
   */
  async getAvailableBalance(walletId: string, exec: DbExecutor = db): Promise<number> {
    const balanceMinor = await readBalance(walletId, exec);
    if (balanceMinor === undefined) {
      return 0;
    }
    return balanceMinor - (await sumActiveHolds(walletId, exec));
  },

  /**
   * BAL-474 (ADR-1040 Amendment 7 §H, D8.5) — the BOOKING figure: `balance − Σ active holds netted
   * by their sessions' posted consumption` (see the module docblock for why it differs from
   * {@link getAvailableBalance}). Both reads run on `exec` — `bookingFundingRepository` passes its
   * one repeatable-read snapshot transaction. Returns 0 when the wallet does not exist.
   *
   * Worked example (plan §I.2): balance 50,000; a live 30-minute session at 700 / min holds 21,000;
   * at minute 20 the balance is 36,000. Gross available is 15,000; netted is
   * 36,000 − (21,000 − 14,000) = 29,000.
   */
  async getAvailableForBooking(walletId: string, exec: DbExecutor): Promise<number> {
    const balanceMinor = await readBalance(walletId, exec);
    if (balanceMinor === undefined) {
      return 0;
    }
    return balanceMinor - (await sumActiveHoldsNetOfConsumption(walletId, exec));
  },
};
