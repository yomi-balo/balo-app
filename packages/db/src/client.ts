import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createLogger } from '@balo/shared/logging';
import * as schema from './schema';

const dbLogger = createLogger('db');

export type Database = PostgresJsDatabase<typeof schema>;

function createProductionDb(): Database {
  const connectionString = process.env.DATABASE_URL!;
  // ⚠️ `prepare: false` IS LOAD-BEARING. Do not remove it, and do not "optimise" it away.
  //
  // Drizzle already sends application SQL unnamed (it routes everything through
  // `client.unsafe`, which hard-codes `prepare: false`). But postgres-js issues its OWN
  // transaction control as TAGGED template literals — `sql`commit`` — which ARE prepared and
  // given a server-side NAME cached per socket. `BEGIN` is unnamed; only `COMMIT` is named.
  //
  // The apps connect through Supabase's TRANSACTION-mode pooler (port 6543), where a socket
  // is rebound to a different backend between transactions. The second and later transaction
  // on a socket can therefore reach a backend that never parsed that name → 26000 `prepared
  // statement "…" does not exist`, which aborts the open transaction. postgres-js then makes
  // it invisible: `FetchPreparedStatement` is in its `retryRoutines`, so instead of rejecting
  // it re-executes COMMIT — inside a now-aborted block. Postgres allows that, rolls back, and
  // returns the tag ROLLBACK with NO error. `db.transaction()` RESOLVES, the caller believes
  // it committed, and every write in that transaction is gone.
  //
  // This was not theoretical: it silently discarded a real A$300 wallet credit — ledger entry
  // applied and logged, wallet updated, "webhook processed", HTTP 200 returned to Stripe, and
  // nothing whatsoever persisted (not even the webhook marker). Card charged, credit lost, no
  // error anywhere. Reproduced against Postgres 16: with the default `prepare: true`, a
  // transaction following `DEALLOCATE ALL` (exactly what the pooler's backend hand-over looks
  // like to the driver) loses its write and throws nothing.
  //
  // `prepare: false` also makes the swallowing path structurally unreachable — `q.prepared`
  // stays false, so postgres-js's retry branch can never fire and a genuine COMMIT failure
  // surfaces as a real rejection (→ 500 → the provider retries). Application SQL is unchanged,
  // so there is no behavioural or performance cost.
  //
  // Pinned by `client.prepared-commit.integration.test.ts`. No other gate can see this.
  const client = postgres(connectionString, { prepare: false });
  return drizzle(client, {
    schema,
    logger: {
      logQuery(query: string, params: unknown[]) {
        dbLogger.debug({ query: query.slice(0, 200), params: params.length }, 'Database query');
      },
    },
  });
}

// Use `let` so integration tests can swap in the testcontainer client via _setDb().
// In production, DATABASE_URL is always set and the client initializes eagerly.
// In test environments, DATABASE_URL is absent — _setDb() must be called before any query.
// eslint-disable-next-line import/no-mutable-exports
export let db: Database = process.env.DATABASE_URL
  ? createProductionDb()
  : (undefined as unknown as Database);

/** @internal Override the DB instance — used by integration test setup */
export function _setDb(testDb: Database): void {
  db = testDb;
}
