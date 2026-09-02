import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../schema';
import { type Database } from '../client';

export { _setDb } from '../client';

/**
 * THE ESCAPE HATCH FROM `setup-integration.ts`.
 *
 * The standard integration harness runs every test inside ONE transaction on a `max:1`
 * pool. That is exactly right for the 99% — and it makes concurrency INEXPRESSIBLE: a
 * second connection cannot exist, and nothing written in the per-test transaction is
 * visible to any other session. A test that must prove behaviour under two simultaneous
 * requests therefore has to open its OWN clients, commit for real, and clean up by hand.
 *
 * `createConcurrentDb(url)` with no options matches how `packages/db/src/client.ts` builds
 * the production one: `prepare: false`, default pool (max 10) — so a reproduction is not
 * quietly running on a different driver configuration than production.
 *
 * ⚠ `prepare: false` is the DEFAULT here deliberately, and it is not a style choice. With
 * prepared statements ON, postgres-js names its own `COMMIT` per socket; across a pooler
 * backend hand-over that name goes missing (26000) and the driver's `retryRoutines` re-runs
 * the COMMIT inside the aborted block, so the transaction silently rolls back while
 * `db.transaction()` RESOLVES. A concurrency suite running that way would be asserting
 * against a driver configuration production deliberately does not use — and could "pass"
 * while writes vanished. Pass `{ prepare: true }` explicitly ONLY to characterise that
 * hazard (see `client.prepared-commit.integration.test.ts`), never for ordinary tests.
 * It lives in `packages/db` (not in the consuming test) so it picks up THIS workspace's
 * `drizzle-orm`; `apps/api` declares no `drizzle-orm` of its own, and a `drizzle` imported
 * from there resolves to whatever version happens to be above the repo on disk.
 *
 * The caller owns the lifecycle: pass the returned `db` to `_setDb` (re-exported here) in a
 * `beforeEach` — AFTER the harness's own `beforeEach` has installed the per-test
 * transaction — `end()` the client and delete the rows in `afterAll`.
 */
export function createConcurrentDb(
  url: string,
  options: Parameters<typeof postgres>[1] = {}
): { db: Database; client: ReturnType<typeof postgres> } {
  // `prepare: false` is spread FIRST, not supplied as a default parameter. A default fires
  // only on `undefined`, so any caller passing an options object at all — `{ max: 1 }`, say —
  // would replace it wholesale and silently inherit postgres-js's `prepare: true`. Three of
  // this helper's four call sites pass options, including both tests asserting the
  // commit-durability invariant, so a default would have left them on the one driver
  // configuration this repo declares unsafe. Spreading `options` after still lets a caller
  // opt IN to `{ prepare: true }` deliberately, which is the only legitimate use.
  const client = postgres(url, { prepare: false, ...options });
  return { db: drizzle(client, { schema }), client };
}
