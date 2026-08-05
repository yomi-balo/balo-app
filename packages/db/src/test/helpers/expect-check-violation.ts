import { expect } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { db } from '../../client';

/**
 * Assert a raw statement violates a CHECK (23514), running it inside its OWN SAVEPOINT.
 *
 * ⚠ LOAD-BEARING. The integration harness holds every test inside one outer transaction,
 * and a failed statement ABORTS it — every subsequent statement then fails
 * `25P02 current transaction is aborted` instead of the constraint code you meant to
 * assert. A nested `db.transaction` is a SAVEPOINT (see test/setup-integration.ts), so
 * the rollback is contained and the next probe in the same test still runs.
 *
 * Lives here rather than as a local in one suite so the several suites that probe CHECK
 * backstops with raw SQL share ONE implementation (a second copy is both a Sonar
 * new-code duplication finding and a copy that keeps passing after the original's
 * savepoint discipline is broken).
 */
export async function expectCheckViolation(statement: SQL): Promise<void> {
  await expect(db.transaction(async (tx) => tx.execute(statement))).rejects.toMatchObject({
    code: '23514',
  });
}
