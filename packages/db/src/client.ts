import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createLogger } from '@balo/shared/logging';
import * as schema from './schema';

const dbLogger = createLogger('db');

export type Database = PostgresJsDatabase<typeof schema>;

function createProductionDb(): Database {
  const connectionString = process.env.DATABASE_URL!;
  const client = postgres(connectionString);
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
