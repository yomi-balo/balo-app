import { asc, eq, sql } from 'drizzle-orm';
import { WALLET_EXPIRY_MONTHS } from '@balo/shared/pricing';
import { db } from '../client';
import {
  creditLedger,
  creditWallets,
  type CreditEntryType,
  type CreditLedgerEntry,
  type CreditLedgerReason,
  type CreditWallet,
} from '../schema';
import { acquireWalletLock } from './_shared/wallet-lock';
import { recordCreditAudit, type CreditAuditAction } from './_shared/credit-audit';
import { balanceContribution } from './_shared/credit-views';

/** Active transaction handle (matches `advanceEngagementStatus` in engagements.ts). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Thrown when a ledger write targets a wallet that does not exist. */
export class WalletNotFoundError extends Error {
  constructor(public readonly walletId: string) {
    super(`Credit wallet not found: ${walletId}`);
    this.name = 'WalletNotFoundError';
  }
}

export interface ApplyLedgerEntryInput {
  walletId: string;
  entryType: CreditEntryType;
  reason: CreditLedgerReason;
  /** Signed AUD minor units — the ONLY balance-affecting figure. */
  amountMinor: number;
  /** From `deriveIdempotencyKey(...)` — never random. */
  idempotencyKey: string;
  /** REQUIRED for session_consume / overdraft_settlement (a dev guard enforces it). */
  memberId?: string | null;
  sessionId?: string | null;
  /** Display / record only — never in balance math. */
  chargedCurrency?: string | null;
  chargedAmountMinor?: number | null;
  fxRate?: string | null;
  stripePaymentIntentId?: string | null;
}

export interface ApplyLedgerEntryResult {
  entry: CreditLedgerEntry;
  /** Post-write wallet (or the unchanged current wallet, on dedup). */
  wallet: CreditWallet;
  /** `true` ⇒ idempotency no-op: nothing credited/debited, no audit row. */
  deduped: boolean;
}

/**
 * The reasons whose ledger entry ALSO writes a member-attributed `audit_events` row,
 * in the SAME txn as the ledger insert + balance update (invariant #7). System entries
 * (auto_topup / dormancy_expiry / promo / adjustment) write no audit row.
 */
const AUDIT_ACTION_BY_REASON: Partial<Record<CreditLedgerReason, CreditAuditAction>> = {
  session_consume: 'credit_wallet.consumed',
  overdraft_settlement: 'credit_wallet.settled',
};

/** Read + lock nothing — just fetch the wallet or throw `WalletNotFoundError`. */
async function readWalletOrThrow(tx: DbTx, walletId: string): Promise<CreditWallet> {
  const [wallet] = await tx
    .select()
    .from(creditWallets)
    .where(eq(creditWallets.id, walletId))
    .limit(1);
  if (wallet === undefined) {
    throw new WalletNotFoundError(walletId);
  }
  return wallet;
}

/** Fetch the ledger row for an idempotency key (post-lock dedup lookup). */
async function findLedgerByKey(tx: DbTx, key: string): Promise<CreditLedgerEntry | undefined> {
  const [row] = await tx
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.idempotencyKey, key))
    .limit(1);
  return row;
}

/**
 * The single atomic ledger-write primitive (BAL-376 / ADR-1040) — mirrors the exported
 * `advanceEngagementStatus` module-function pattern. Runs INSIDE the caller's `tx`
 * (the advisory lock in step 1 only holds for a transaction). Standalone callers use
 * `creditLedgerRepository.postEntry`, which self-wraps in `db.transaction`.
 *
 * Algorithm (single txn):
 *  1. Advisory lock the wallet — serialize all concurrent same-wallet writes.
 *  2. Idempotency no-op check — an existing key returns `{ deduped: true }` WITHOUT
 *     inserting or touching the balance (the advisory lock serializes duplicates).
 *  3. Read the wallet (throw `WalletNotFoundError`). balanceAfter = balance + amount.
 *     NO overdraft/insufficiency gate here — mechanism, not policy; balance may
 *     legitimately go negative (overdraft grace).
 *  4. Insert the ledger row; `onConflictDoNothing` on `idempotency_key` is the hard
 *     backstop — if it returns nothing (a race beat step 2) re-select and dedup.
 *  5. Update the balance cache; roll `expires_at` to now + WALLET_EXPIRY_MONTHS for
 *     EVERY entry EXCEPT `entry_type='expiry'` (a dormancy-expiry entry must not extend
 *     the wallet's own life).
 *  6. For session_consume / overdraft_settlement, write the member-attributed audit row
 *     in the SAME txn (invariant #7). A dev guard (top) throws if memberId is missing.
 *
 * A throw anywhere in 1–6 rolls back the ledger insert, balance update, AND audit row
 * together.
 */
export async function applyLedgerEntry(
  tx: DbTx,
  input: ApplyLedgerEntryInput
): Promise<ApplyLedgerEntryResult> {
  const auditAction = AUDIT_ACTION_BY_REASON[input.reason];

  // Dev-time guard: member-attributed reasons must carry an actor — attribution can
  // never silently go missing.
  if (auditAction !== undefined && (input.memberId === undefined || input.memberId === null)) {
    throw new Error(
      `applyLedgerEntry: reason '${input.reason}' requires a memberId for attribution`
    );
  }

  // 1. Advisory lock — single-in-flight per wallet.
  await acquireWalletLock(tx, input.walletId);

  // 2. Idempotency no-op check.
  const existing = await findLedgerByKey(tx, input.idempotencyKey);
  if (existing !== undefined) {
    const wallet = await readWalletOrThrow(tx, input.walletId);
    return { entry: existing, wallet, deduped: true };
  }

  // 3. Read the wallet + compute the new balance (no policy gate). Balance math routes
  //    through `balanceContribution` so the "only amount_minor moves the balance"
  //    invariant (#8) is enforced BY CONSTRUCTION in the production path — charged_*/
  //    fx_rate are structurally excluded, and the helper's unit test guards this code.
  const wallet = await readWalletOrThrow(tx, input.walletId);
  const balanceAfter =
    wallet.balanceMinor +
    balanceContribution({
      amountMinor: input.amountMinor,
      chargedCurrency: input.chargedCurrency ?? null,
      chargedAmountMinor: input.chargedAmountMinor ?? null,
      fxRate: input.fxRate ?? null,
    });

  // 4. Insert the ledger row (UNIQUE + onConflictDoNothing is the backstop).
  const [inserted] = await tx
    .insert(creditLedger)
    .values({
      walletId: input.walletId,
      entryType: input.entryType,
      reason: input.reason,
      amountMinor: input.amountMinor,
      balanceAfterMinor: balanceAfter,
      memberId: input.memberId ?? null,
      sessionId: input.sessionId ?? null,
      chargedCurrency: input.chargedCurrency ?? null,
      chargedAmountMinor: input.chargedAmountMinor ?? null,
      fxRate: input.fxRate ?? null,
      stripePaymentIntentId: input.stripePaymentIntentId ?? null,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: creditLedger.idempotencyKey })
    .returning();

  if (inserted === undefined) {
    // A concurrent insert beat our step-2 SELECT to the unique key. Re-select + dedup.
    const raced = await findLedgerByKey(tx, input.idempotencyKey);
    if (raced === undefined) {
      throw new Error('credit_ledger insert conflicted but the conflicting row was not found');
    }
    const currentWallet = await readWalletOrThrow(tx, input.walletId);
    return { entry: raced, wallet: currentWallet, deduped: true };
  }

  // 5. Update the balance cache; roll expires_at EXCEPT for expiry entries.
  const walletUpdate =
    input.entryType === 'expiry'
      ? { balanceMinor: balanceAfter }
      : {
          balanceMinor: balanceAfter,
          expiresAt: sql`now() + make_interval(months => ${WALLET_EXPIRY_MONTHS})`,
        };

  const [updatedWallet] = await tx
    .update(creditWallets)
    .set(walletUpdate)
    .where(eq(creditWallets.id, input.walletId))
    .returning();
  if (updatedWallet === undefined) {
    throw new WalletNotFoundError(input.walletId);
  }

  // 6. Member-attributed audit (consume/settlement only), same txn.
  if (auditAction !== undefined) {
    await recordCreditAudit(tx, {
      actorUserId: input.memberId ?? null,
      action: auditAction,
      walletId: input.walletId,
      ledgerEntryId: inserted.id,
      companyId: updatedWallet.companyId,
      sessionId: input.sessionId ?? null,
      entryType: input.entryType,
      reason: input.reason,
      amountMinor: input.amountMinor,
      balanceAfterMinor: balanceAfter,
    });
  }

  return { entry: inserted, wallet: updatedWallet, deduped: false };
}

export const creditLedgerRepository = {
  /** Standalone convenience wrapper — self-wraps `applyLedgerEntry` in a transaction. */
  async postEntry(input: ApplyLedgerEntryInput): Promise<ApplyLedgerEntryResult> {
    return db.transaction((tx) => applyLedgerEntry(tx, input));
  },

  /** The ledger row for an idempotency key, if any. */
  async findByIdempotencyKey(key: string): Promise<CreditLedgerEntry | undefined> {
    return db.query.creditLedger.findFirst({ where: eq(creditLedger.idempotencyKey, key) });
  },

  /**
   * Append-only history for a wallet, oldest first. Orders by the monotonic `seq`
   * identity — NOT `created_at` — because Postgres `now()` is transaction-scoped, so
   * several entries appended in one txn tie on `created_at`; `seq` gives a deterministic
   * total order that always matches insertion order.
   */
  async listByWallet(walletId: string): Promise<CreditLedgerEntry[]> {
    return db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.walletId, walletId))
      .orderBy(asc(creditLedger.seq));
  },

  /**
   * `SUM(amount_minor)` for a wallet — the reconciliation source for invariant #3.
   * `SUM(integer)` returns Postgres `bigint` (never overflows); coerced to a JS number.
   */
  async sumAmountByWallet(walletId: string): Promise<number> {
    const [row] = await db
      .select({ sum: sql<string>`coalesce(sum(${creditLedger.amountMinor}), 0)` })
      .from(creditLedger)
      .where(eq(creditLedger.walletId, walletId));
    return Number(row?.sum ?? 0);
  },
};
