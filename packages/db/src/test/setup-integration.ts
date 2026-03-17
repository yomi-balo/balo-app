import { inject, beforeEach, afterEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, destroyTestClient } from './test-client';

// Bridge provide/inject to process.env so test-client.ts can read it
process.env.TEST_DATABASE_URL = inject('testDatabaseUrl');

const db = getTestDb();

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
