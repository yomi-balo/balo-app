import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../schema';
import { _setDb, type Database } from '../client';

export { _setDb };

/**
 * THE ESCAPE HATCH FROM `setup-integration.ts`.
 *
 * The standard integration harness runs every test inside ONE transaction on a `max:1`
 * pool. That is exactly right for the 99% — and it makes concurrency INEXPRESSIBLE: a
 * second connection cannot exist, and nothing written in the per-test transaction is
 * visible to any other session. A test that must prove behaviour under two simultaneous
 * requests therefore has to open its OWN clients, commit for real, and clean up by hand.
 *
 * `createConcurrentDb(url)` with no options builds the client EXACTLY as
 * `packages/db/src/client.ts` builds the production one — a bare
 * `postgres(connectionString)`: prepared statements ON, default pool (max 10) — so a
 * reproduction is not quietly running on a different driver configuration than production.
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
  const client = postgres(url, options);
  return { db: drizzle(client, { schema }), client };
}
