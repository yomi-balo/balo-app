import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../schema';
import type { Database } from '../client';

let _client: ReturnType<typeof postgres> | undefined;
let _db: Database | undefined;

export function getTestDb(): Database {
  if (!_db || !_client) {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
      throw new Error(
        'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
      );
    }
    _client = postgres(url, { max: 1 });
    _db = drizzle(_client, { schema });
  }
  return _db;
}

export function getTestClient(): ReturnType<typeof postgres> {
  if (!_client) {
    getTestDb(); // initializes both
  }
  return _client!;
}

export async function destroyTestClient(): Promise<void> {
  if (_client) {
    await _client.end();
    _client = undefined;
    _db = undefined;
  }
}
