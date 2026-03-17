import { inject, beforeEach, afterEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, destroyTestClient } from './test-client';
import { _setDb } from '../client';

// Bridge provide/inject to process.env so test-client.ts can read it
process.env.TEST_DATABASE_URL = inject('testDatabaseUrl');

const db = getTestDb();

// Override the production db singleton so repositories use the test connection.
// This ensures all repository operations participate in the per-test transaction.
_setDb(db);

// Wrap each test in a transaction and roll back after
// This gives hermetic tests without truncating tables
beforeEach(async () => {
  await db.execute(sql`BEGIN`);
});

afterEach(async () => {
  await db.execute(sql`ROLLBACK`);
});

afterAll(async () => {
  await destroyTestClient();
});
