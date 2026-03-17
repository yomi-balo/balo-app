import { inject, beforeEach, afterEach, afterAll } from 'vitest';
import { getTestDb, destroyTestClient } from './test-client';
import { _setDb, type Database } from '../client';

// Bridge provide/inject to process.env so test-client.ts can read it
process.env.TEST_DATABASE_URL = inject('testDatabaseUrl');

const db = getTestDb();

// Use Drizzle's transaction API (not raw BEGIN/ROLLBACK) so that nested
// db.transaction() calls inside repositories produce SAVEPOINTs instead
// of trying to acquire a second connection on the max:1 pool (deadlock).
let rollback: (() => void) | undefined;

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    db.transaction(async (tx) => {
      _setDb(tx as unknown as Database);
      resolve();
      // Hold the transaction open until afterEach signals
      await new Promise<void>((r) => {
        rollback = r;
      });
      throw new Error('rollback');
    }).catch(() => {
      // Expected — the thrown error forces Drizzle to ROLLBACK
    });
  });
});

afterEach(async () => {
  rollback?.();
  rollback = undefined;
  _setDb(db); // restore base client for next beforeEach
});

afterAll(async () => {
  await destroyTestClient();
});
