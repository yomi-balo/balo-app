import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createLogger } from '@balo/shared/logging';
import * as schema from './schema';

const dbLogger = createLogger('db');

const connectionString = process.env.DATABASE_URL!;
const client = postgres(connectionString);

export const db = drizzle(client, {
  schema,
  logger: {
    logQuery(query: string, params: unknown[]) {
      dbLogger.debug({ query: query.slice(0, 200), params: params.length }, 'Database query');
    },
  },
});
export type Database = typeof db;
