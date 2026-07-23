import { asc, desc, eq, sql } from 'drizzle-orm';
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
import { deriveIdempotencyKey } from './_shared/credit-idempotency';
import type { DbExecutor } from './_shared/db-executor';

/** Active transaction handle (matches `advanceEngagementStatus` in engagements.ts). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Thrown when a ledger write targets a wallet that does not exist. */
export class WalletNotFoundError extends Error {
  constructor(public readonly walletId: string) {
    super(`Credit wallet not found: ${walletId}`);
    this.name = 'WalletNotFoundError';
  }
}

/**
 * Thrown when a replayed `idempotency_key` resolves to a stored ledger entry whose payload
 * — wallet, signed amount, reason, or entry-type — differs from the current input. A
 * state-derived key must ALWAYS map to the same logical write; a mismatch means an upstream
 * key-derivation bug, or reuse of a shared token across wallets (the `idempotency_key`
 * unique is global — e.g. an `adjustment` token). Rather than silently no-op onto the wrong
 * money row, the primitive surfaces the conflict.
 */
export class LedgerIdempotencyConflictError extends Error {
  constructor(
    public readonly idempotencyKey: string,
    public readonly existingEntryId: string
  ) {
    super(
      `Idempotency key '${idempotencyKey}' was already applied with a different payload (existing entry ${existingEntryId})`
    );
    this.name = 'LedgerIdempotencyConflictError';
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
  /**
   * Reconciliation triplet passthrough (BAL-382 / Decision A) — record only. Threaded
   * into the ledger insert like `stripePaymentIntentId`; NOT compared in
   * `assertIdempotentMatch` and NOT in `balanceContribution` (they never move money).
   */
  stripeChargeId?: string | null;
  stripeBalanceTransactionId?: string | null;
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
 *
 * `manual_purchase` is member-attributed (BAL-382 / Decision C): an on-session buy is
 * member-initiated, so the provider's purchase function requires an `initiatingMemberId`
 * and threads it back here, satisfying the memberId guard below by construction. This
 * keeps the "ledger effect + audit row atomic" guarantee inside the primitive rather than
 * hand-rolling a second `recordCreditAudit` in the webhook. `auto_topup` stays a system
 * entry with NO audit row (its ledger row + Stripe reference triplet is the record).
 */
const AUDIT_ACTION_BY_REASON: Partial<Record<CreditLedgerReason, CreditAuditAction>> = {
  manual_purchase: 'credit_wallet.purchased',
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
 * Guard a dedup hit: a replayed key MUST resolve to the same logical write. Compares the
 * identity + balance-affecting fields (wallet, signed amount, reason, entry-type); a
 * mismatch throws `LedgerIdempotencyConflictError` rather than deduping onto a different
 * operation (also catches cross-wallet reuse of a shared idempotency token — the unique is
 * global). Display/record-only fields (charged_*, fx_rate, session, stripe PI) are NOT
 * compared: they never move money and can legitimately vary between derivations.
 */
function assertIdempotentMatch(existing: CreditLedgerEntry, input: ApplyLedgerEntryInput): void {
  if (
    existing.walletId !== input.walletId ||
    existing.amountMinor !== input.amountMinor ||
    existing.reason !== input.reason ||
    existing.entryType !== input.entryType
  ) {
    throw new LedgerIdempotencyConflictError(input.idempotencyKey, existing.id);
  }
}

/**
 * The single atomic ledger-write primitive (BAL-376 / ADR-1040) — mirrors the exported
 * `advanceEngagementStatus` module-function pattern. Runs INSIDE the caller's `tx`
 * (the advisory lock in step 1 only holds for a transaction). Standalone callers use
 * `creditLedgerRepository.postEntry`, which self-wraps in `db.transaction`.
 *
 * Algorithm (single txn):
 *  1. Advisory lock the wallet — serialize all concurrent same-wallet writes.
 *  2. Idempotency no-op check — an existing key with a MATCHING payload returns
 *     `{ deduped: true }` WITHOUT inserting or touching the balance (the advisory lock
 *     serializes duplicates). An existing key with a DIFFERENT payload throws
 *     `LedgerIdempotencyConflictError` — never no-op onto the wrong money row.
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

  // 2. Idempotency no-op check — a matching prior entry is a true no-op; the SAME key
  //    derived for a DIFFERENT payload is a conflict, not a silent dedup.
  const existing = await findLedgerByKey(tx, input.idempotencyKey);
  if (existing !== undefined) {
    assertIdempotentMatch(existing, input);
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
      stripeChargeId: input.stripeChargeId ?? null,
      stripeBalanceTransactionId: input.stripeBalanceTransactionId ?? null,
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
    assertIdempotentMatch(raced, input);
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

/**
 * Outcome of a single guarded dormancy-expiry attempt (BAL-380). The sweep publishes the
 * "balance expired" notice on `expired | already_expired` (idempotent by the ledger key)
 * and emits the money-event analytic ONLY on `expired`. `skipped` carries the reason a
 * candidate did not expire under the lock.
 */
export type ExpireDormantResult =
  | {
      outcome: 'expired';
      entry: CreditLedgerEntry;
      expiredMinor: number;
      companyId: string;
      expiresAt: Date;
    }
  | { outcome: 'already_expired'; entry: CreditLedgerEntry; companyId: string; expiresAt: Date }
  | { outcome: 'skipped'; reason: 'not_expired' | 'no_balance' | 'not_found' };

export const creditLedgerRepository = {
  /** Standalone convenience wrapper — self-wraps `applyLedgerEntry` in a transaction. */
  async postEntry(input: ApplyLedgerEntryInput): Promise<ApplyLedgerEntryResult> {
    return db.transaction((tx) => applyLedgerEntry(tx, input));
  },

  /**
   * The guarded, locked, idempotent dormancy-expiry write (BAL-380 / ADR-1040 Lane 3).
   * Zeroes a dormant wallet's positive balance by posting a single
   * `entry_type='expiry' / reason='dormancy_expiry'` ledger entry keyed on the
   * deterministic `dormancy_expiry:${walletId}:${asOf}` idempotency key.
   *
   * Algorithm (single txn):
   *  1. `acquireWalletLock` — serialise against every other same-wallet writer (a consume
   *     or top-up must not interleave between the eligibility read and the decision).
   *  2. Re-read the wallet UNDER the lock; absent → `skipped:'not_found'`.
   *  3. Derive the key from `asOf = now` (UTC `YYYY-MM-DD`).
   *  4. Not-expired guard (D5, the top-up race): a top-up that landed after the sweep's
   *     eligibility read rolled `expires_at` forward + added balance → `expiresAt === null
   *     || expiresAt > now` → `skipped:'not_expired'`. We must NOT expire it.
   *  5. `balanceMinor > 0` → post `amountMinor = -balanceMinor` (zeroes the cache; the
   *     `entry_type='expiry'` arm of `applyLedgerEntry` deliberately does NOT roll
   *     `expires_at`, so an expiry entry can never extend the wallet's own life).
   *     `dormancy_expiry` is a system reason (excluded from `AUDIT_ACTION_BY_REASON`), so
   *     `memberId: null` is correct and the dev attribution guard does not fire.
   *  6. Balance ≤ 0 under the lock → look up the key: found ⇒ `already_expired` (a
   *     CONCURRENT same-tick sweep already posted this expiry; the caller re-publishes the
   *     notice, idempotent by correlationId); not found ⇒ `skipped:'no_balance'` (the
   *     balance was consumed to 0, not expired).
   *
   * Idempotency & durability: once expired the balance is 0, so the wallet drops out of
   * `findExpirableWallets` on every future tick (even though `expires_at` stays `<= now`) —
   * money is written exactly once, no double-debit. That also means `already_expired` only
   * guards concurrent same-tick runs, NOT cross-tick crash recovery: if the process dies (or
   * the notify fails) between this commit and the caller's publish, the zeroed wallet is
   * never re-selected, so the courtesy "expired" notice is lost. The money stays correct —
   * only the notification is best-effort.
   */
  async expireDormantBalance({
    walletId,
    now,
  }: {
    walletId: string;
    now: Date;
  }): Promise<ExpireDormantResult> {
    return db.transaction(async (tx) => {
      // 1. Advisory lock — serialise against consume / top-up on this wallet.
      await acquireWalletLock(tx, walletId);

      // 2. Re-read UNDER the lock (non-throwing — an absent wallet is a skip, not an error).
      const [wallet] = await tx
        .select()
        .from(creditWallets)
        .where(eq(creditWallets.id, walletId))
        .limit(1);
      if (wallet === undefined) {
        return { outcome: 'skipped', reason: 'not_found' };
      }

      // 3. Deterministic key — one expiry per wallet per UTC sweep date.
      const asOf = now.toISOString().slice(0, 10);
      const key = deriveIdempotencyKey({ reason: 'dormancy_expiry', walletId, asOf });

      // 4. Not-expired guard (D5): a top-up rolled expires_at forward after the eligibility
      //    read — never expire a wallet whose (re-read) expiry is null or still in the future.
      const { expiresAt } = wallet;
      if (expiresAt === null || expiresAt > now) {
        return { outcome: 'skipped', reason: 'not_expired' };
      }

      // 5. Positive balance → post the zeroing expiry entry.
      if (wallet.balanceMinor > 0) {
        const result = await applyLedgerEntry(tx, {
          walletId,
          entryType: 'expiry',
          reason: 'dormancy_expiry',
          amountMinor: -wallet.balanceMinor,
          idempotencyKey: key,
          memberId: null,
        });
        return {
          outcome: 'expired',
          entry: result.entry,
          expiredMinor: wallet.balanceMinor,
          companyId: wallet.companyId,
          expiresAt,
        };
      }

      // 6. Balance ≤ 0 under the lock: distinguish an already-posted expiry (replay) from a
      //    balance consumed to 0.
      const existing = await findLedgerByKey(tx, key);
      if (existing !== undefined) {
        return {
          outcome: 'already_expired',
          entry: existing,
          companyId: wallet.companyId,
          expiresAt,
        };
      }
      return { outcome: 'skipped', reason: 'no_balance' };
    });
  },

  /** The ledger row for an idempotency key, if any. */
  async findByIdempotencyKey(key: string): Promise<CreditLedgerEntry | undefined> {
    return db.query.creditLedger.findFirst({ where: eq(creditLedger.idempotencyKey, key) });
  },

  /**
   * The id of the wallet's LATEST ledger entry (max `seq`) — the entry that produced the
   * current resting balance (BAL-379). `undefined` when the wallet has no ledger rows.
   * Orders by the monotonic `seq` identity, NOT `created_at` (transaction-scoped `now()`
   * ties several same-txn appends), matching `listByWallet`'s canonical total order.
   *
   * Threads the caller's `exec` so the auto-top-up engine reads it UNDER its per-wallet
   * advisory lock, in the SAME consistent snapshot as the balance/mandate it decides on:
   * two concurrent evaluations then pin the SAME entry id ⇒ derive the SAME
   * `auto_topup:{walletId}:{entryId}` idempotency key ⇒ Stripe collapses them to one charge.
   */
  async getLatestEntryId(walletId: string, exec: DbExecutor = db): Promise<string | undefined> {
    const [row] = await exec
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.walletId, walletId))
      .orderBy(desc(creditLedger.seq))
      .limit(1);
    return row?.id;
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
