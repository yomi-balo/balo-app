import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  creditHolds,
  creditWallets,
  type CreditHold,
  type CreditHoldStatus,
  type NewCreditHold,
} from '../schema';

/** Active transaction handle (matches the engagements pattern). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * `SUM(amount_minor)` over a wallet's ACTIVE, non-deleted holds — the single correct
 * active-holds sum, shared by `sumActiveByWallet` and `getAvailableBalance` so the two
 * can never drift. Rides `credit_holds_wallet_active_idx`; settled/released/soft-deleted
 * holds are excluded. Returns 0 when the wallet has no active holds.
 */
async function sumActiveHolds(walletId: string): Promise<number> {
  const [row] = await db
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
 * Resolve an `active` hold to a terminal status under a row lock. Guards: missing hold
 * → `Error`; non-`active` current status → `InvalidHoldTransitionError` (no double
 * settle/release). When `memberId` is provided, records the RESOLVING member (the last
 * actor) on `member_id`.
 */
async function resolveHold(
  holdId: string,
  to: Extract<CreditHoldStatus, 'settled' | 'released'>,
  opts: { memberId?: string | null }
): Promise<CreditHold> {
  return db.transaction(async (tx: DbTx) => {
    const [current] = await tx
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

    const [updated] = await tx
      .update(creditHolds)
      .set(set)
      .where(eq(creditHolds.id, holdId))
      .returning();
    if (updated === undefined) {
      throw new Error(`Failed to resolve credit hold: ${holdId}`);
    }
    return updated;
  });
}

export const creditHoldsRepository = {
  /**
   * Place an `active` reservation. A hold moves NO money and takes NO advisory lock
   * (this ticket keeps `place` lock-free; a later place+consume-atomic lane may add
   * one). Raw FK violation (23503) on an unknown wallet; CHECK (23514) on a
   * non-positive `amountMinor`.
   */
  async place(input: {
    walletId: string;
    sessionId?: string | null;
    memberId?: string | null;
    amountMinor: number;
  }): Promise<CreditHold> {
    const [row] = await db
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

  /** Settle a hold (active → settled). Guarded: only from `active`. */
  async settle(holdId: string, opts: { memberId?: string | null } = {}): Promise<CreditHold> {
    return resolveHold(holdId, 'settled', opts);
  },

  /** Release a hold (active → released). Guarded: only from `active`. */
  async release(holdId: string, opts: { memberId?: string | null } = {}): Promise<CreditHold> {
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
   * ADVISORY, NOT ATOMIC. These are two separate reads on the base `db` connection, so the
   * figure can be momentarily stale under concurrent hold/ledger writes and cannot observe
   * a caller's uncommitted transaction. Safe for display and soft pre-checks only. A
   * money-gating lane (BAL-377+) MUST NOT treat this as an authoritative funds gate:
   * re-derive available balance inside its own `db.transaction` AFTER `acquireWalletLock`,
   * where the per-wallet advisory lock serializes it against every other wallet writer.
   */
  async getAvailableBalance(walletId: string): Promise<number> {
    const [wallet] = await db
      .select({ balanceMinor: creditWallets.balanceMinor })
      .from(creditWallets)
      .where(eq(creditWallets.id, walletId))
      .limit(1);
    if (wallet === undefined) {
      return 0;
    }
    return wallet.balanceMinor - (await sumActiveHolds(walletId));
  },
};
