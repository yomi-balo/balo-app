import { sql } from 'drizzle-orm';
import type { DbExecutor } from './db-executor';

/**
 * Acquire the per-wallet single-in-flight advisory lock for the CURRENT transaction
 * (BAL-376 / ADR-1040). `pg_advisory_xact_lock` is held for the life of the
 * transaction and released automatically at COMMIT/ROLLBACK — so this MUST run inside
 * a real transaction (the base auto-commit `db` cannot hold it across statements).
 *
 * ⚠ "`applyLedgerEntry` is the sole caller" WAS STALE AND IS CORRECTED (BAL-546). There are 12
 * production call sites today: `credit-ledger.ts` (2), `credit-sessions.ts` (7, multiple
 * settlement paths), `apps/api/.../credit/auto-topup.ts` (1), `apps/api/.../credit-
 * session/end-session.ts` (1), and `apps/api/.../stripe/dispatch.ts` (1). Anything that posts a
 * ledger entry or otherwise touches a wallet's balance-affecting state takes this lock first.
 *
 * ⚠ A SECOND ADVISORY-LOCK CLASS NOW EXISTS (BAL-546) — the per-request class in
 * `_shared/request-lock.ts`. The two are disjoint (no repository file takes both — mechanically
 * pinned in `invariants/an-account-hold-outlives-only-an-unpaid-balance.test.ts`) and share one
 * flat 64-bit `pg_advisory_xact_lock(bigint)` key space. The request class's `'project_request:'`
 * string-namespace prefix removes only the SYSTEMATIC collision (a UUID that is both a wallet id
 * and a request id hashing identically every time) — a random 64-bit hash collision between the
 * two classes remains at ~2⁻⁶⁴ (fix round F2; see `request-lock.ts` for the full reasoning). If a
 * future transaction ever needs both locks: **this wallet lock FIRST**, then the request lock.
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
