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

/** The savepoint handle a probe runs on. Must be used INSTEAD of the module-level `db`. */
type ProbeTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The Drizzle-query generalisation of `expectCheckViolation`: assert that `run` fails with
 * a given SQLSTATE (`23505` unique, `23503` FK, `23514` CHECK, …), inside its OWN
 * SAVEPOINT.
 *
 * ⚠ `run` MUST issue its statements on the supplied `tx`, never on the module-level `db`.
 * `db` is the OUTER per-test transaction; a failure on it aborts that transaction and
 * every later statement in the test fails `25P02` instead of the code you meant to assert.
 */
export async function expectConstraintViolation(
  code: string,
  run: (tx: ProbeTx) => Promise<unknown>
): Promise<void> {
  await expect(db.transaction(async (tx) => run(tx))).rejects.toMatchObject({ code });
}
