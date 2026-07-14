import { sql } from 'drizzle-orm';
import type { DbExecutor } from './db-executor';

/**
 * Acquire the per-wallet single-in-flight advisory lock for the CURRENT transaction
 * (BAL-376 / ADR-1040). `pg_advisory_xact_lock` is held for the life of the
 * transaction and released automatically at COMMIT/ROLLBACK — so this MUST run inside
 * a real transaction (the base auto-commit `db` cannot hold it across statements).
 * `applyLedgerEntry` (which threads a `tx`) is the sole caller.
 *
 * Serializes ALL concurrent money-affecting writes to the SAME wallet: two
 * near-simultaneous consumes that each observe "below threshold" can't both fire a
 * reload — the second serializes behind the first and then sees the committed
 * `auto_topup` idempotency key. A double-credit is a real money bug (ADR-1040).
 *
 * `hashtextextended(walletId, 0)` maps the wallet-id text to the single `bigint` key
 * the lock function takes; DISTINCT wallets hash to distinct keys and never contend.
 */
export async function acquireWalletLock(exec: DbExecutor, walletId: string): Promise<void> {
  await exec.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${walletId}, 0))`);
}
