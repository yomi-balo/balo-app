import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, type Database } from '../../client';
import { createConcurrentDb } from '../../test/concurrent-client';
import { proposalFactory, requestExpertRelationshipFactory } from '../../test/factories';
import {
  acquireRequestLock,
  acquireRequestLockViaProposalTx,
  acquireRequestLockViaRelationshipTx,
} from './request-lock';

/**
 * ⚠ WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. These run inside the standard harness's single
 * transaction on a `max: 1` pool (`test/setup-integration.ts`), so they prove the statements
 * execute and the reads resolve correctly — they prove NOTHING about serialization against a
 * second, genuinely concurrent connection. The serialization proof is
 * `request-domain-serialization.concurrency.integration.test.ts`.
 */
describe('acquireRequestLock', () => {
  it('resolves and is re-entrant — calling it twice in one transaction does not hang', async () => {
    // fix round R8 (SonarCloud S2699) — assert the resolved value, not just that the `await`
    // above didn't throw. `db.transaction` resolves to its callback's return value, which is
    // `undefined` here (neither call returns anything) — a genuine, if modest, assertion that
    // the re-entrant pair actually completed rather than one of them hanging silently.
    const result = await db.transaction(async (tx) => {
      const requestId = randomUUID();
      await acquireRequestLock(tx, requestId);
      await acquireRequestLock(tx, requestId);
    });
    expect(result).toBeUndefined();
  });
});

describe('acquireRequestLockViaRelationshipTx', () => {
  it("returns the relationship's projectRequestId and takes the lock", async () => {
    const { relationship, projectRequestId } = await requestExpertRelationshipFactory();

    const resolved = await db.transaction((tx) =>
      acquireRequestLockViaRelationshipTx(tx, relationship.id)
    );

    expect(resolved).toBe(projectRequestId);
  });

  it('returns undefined for a missing relationship id', async () => {
    const resolved = await db.transaction((tx) =>
      acquireRequestLockViaRelationshipTx(tx, randomUUID())
    );

    expect(resolved).toBeUndefined();
  });

  it('returns undefined for a soft-deleted relationship', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { deletedAt: new Date() },
    });

    const resolved = await db.transaction((tx) =>
      acquireRequestLockViaRelationshipTx(tx, relationship.id)
    );

    expect(resolved).toBeUndefined();
  });
});

describe('acquireRequestLockViaProposalTx', () => {
  it("returns the proposal's projectRequestId and takes the lock", async () => {
    const { proposal, projectRequestId } = await proposalFactory();

    const resolved = await db.transaction((tx) => acquireRequestLockViaProposalTx(tx, proposal.id));

    expect(resolved).toBe(projectRequestId);
  });

  it('returns undefined for a missing proposal id', async () => {
    const resolved = await db.transaction((tx) =>
      acquireRequestLockViaProposalTx(tx, randomUUID())
    );

    expect(resolved).toBeUndefined();
  });

  it('returns undefined for a soft-deleted proposal', async () => {
    const { proposal } = await proposalFactory({ values: { deletedAt: new Date() } });

    const resolved = await db.transaction((tx) => acquireRequestLockViaProposalTx(tx, proposal.id));

    expect(resolved).toBeUndefined();
  });
});

/**
 * ⚠⚠ fix round R2 — THE MISSING PROOF. By the PR's own mutation standard, deleting
 * `_shared/request-lock.ts`'s `SET LOCAL lock_timeout = '3s'` line left every one of the
 * 3,350+ existing tests green: nothing anywhere asserted the setting actually took, only that
 * `acquireRequestLock` resolves. These two blocks close that gap.
 *
 * Runs inside the STANDARD single-tx harness (`db`, `max: 1` pool, one wrapping transaction per
 * test) — `SHOW lock_timeout` is a plain session-state read, so no second connection is needed
 * to observe it.
 */
describe('acquireRequestLock — lock_timeout scoping (fix round R1(a)/R2/R9)', () => {
  it('sets lock_timeout for the gate wait, then resets it to the value in effect before acquiring', async () => {
    const requestId = randomUUID();

    const { shownBefore, shownAfter } = await db.transaction(async (tx) => {
      // Captured BEFORE `acquireRequestLock` runs, so this test pins the PROPERTY the R9 fix
      // docblock claims — that `DEFAULT` restores the CONFIGURED default `lock_timeout` in effect
      // for this session — rather than an incidentally-correct literal. On this harness that
      // value is '0' today, but the assertion below does not hardcode that; it compares against
      // this capture.
      //
      // ⚠ BAL-559 INTERACTION (see `_shared/request-lock.ts`'s R9 docblock section for the full
      // argument). This capture is taken from the SAME production client module (`../../client`)
      // that BAL-559's proposed global `lock_timeout` would configure. If BAL-559 adds
      // `lock_timeout` to the connection options, `shownBefore` here starts reflecting that
      // connection-level value too — and so would `shownAfter`, since `DEFAULT` only restores the
      // CONFIGURED default, not a connection-option value set at connect time. In that world this
      // assertion is expected to keep passing only if `DEFAULT` happens to coincide with the
      // connection-option value; the more likely failure is that `shownAfter` stops matching
      // `shownBefore` and this test goes RED. That red is EXPECTED and CORRECT — it is this test
      // doing its job, not a regression — and the fix at that point is to switch the reset in
      // `acquireRequestLock` from `SET LOCAL lock_timeout = DEFAULT` to a captured-and-restored
      // `set_config('lock_timeout', <captured value>, true)`, which (unlike `SET`) accepts a bind
      // parameter, so the actual prior value can be restored rather than the configured default.
      const beforeRows = (await tx.execute(sql`SHOW lock_timeout`)) as unknown as Array<{
        lock_timeout: string;
      }>;
      const [beforeRow] = beforeRows;
      if (beforeRow === undefined) throw new Error('SHOW lock_timeout returned no row');

      await acquireRequestLock(tx, requestId);
      // ⚠ THIS IS THE R2 MUTATION TARGET. Delete `_shared/request-lock.ts`'s trailing
      // `SET LOCAL lock_timeout = DEFAULT` (the R1(a)/R9 reset) and `shownAfter` below reads back
      // `'3s'` instead of matching `shownBefore` — this assertion goes RED.
      const afterRows = (await tx.execute(sql`SHOW lock_timeout`)) as unknown as Array<{
        lock_timeout: string;
      }>;
      const [afterRow] = afterRows;
      if (afterRow === undefined) throw new Error('SHOW lock_timeout returned no row');

      return { shownBefore: beforeRow.lock_timeout, shownAfter: afterRow.lock_timeout };
    });

    expect(shownAfter).toBe(shownBefore);
  });
});

/**
 * The other half of R2: a REAL 55P03, not a synthetic `{ code: '55P03' }` object. Requires TWO
 * genuinely simultaneous Postgres backends (D10) — the standard single-tx harness cannot express
 * a second connection at all, so this uses `createConcurrentDb`, exactly like the five
 * established concurrency suites (never raw `postgres(url, { max: 1 })` — D10's named-COMMIT
 * silent-rollback footgun).
 *
 * ⚠ THIS FILE MUST NOT CONTAIN THE LITERAL `pg_advisory` IN CODE (D1/D15's amended lock-class
 * scan, `invariants/an-account-hold-outlives-only-an-unpaid-balance.test.ts`, which walks
 * `*.test.ts` too). It reaches the lock only through the imported `acquireRequestLock` symbol —
 * never a raw `pg_advisory_xact_lock` statement of its own.
 *
 * No factory seeding is needed here (unlike the sibling concurrency suites): `acquireRequestLock`
 * never reads or validates the `project_requests` table — it hashes the id text directly — so a
 * bare `randomUUID()` shared by both connections is a real, contending lock key with nothing to
 * clean up afterwards.
 */
describe('acquireRequestLock — a genuine 55P03 against a held lock (fix round R2)', () => {
  let holderClient: ReturnType<typeof createConcurrentDb>['client'];
  let waiterClient: ReturnType<typeof createConcurrentDb>['client'];
  let holderDb: Database;
  let waiterDb: Database;

  beforeAll(() => {
    const url = process.env.TEST_DATABASE_URL;
    if (url === undefined || url.length === 0) {
      throw new Error(
        'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
      );
    }
    ({ db: holderDb, client: holderClient } = createConcurrentDb(url, { max: 1 }));
    ({ db: waiterDb, client: waiterClient } = createConcurrentDb(url, { max: 1 }));
  });

  afterAll(async () => {
    await Promise.all([holderClient?.end({ timeout: 5 }), waiterClient?.end({ timeout: 5 })]);
  });

  /** Take the lock on `target` and leave the transaction OPEN until `release()` is called. */
  async function holdRequestLock(
    target: Database,
    requestId: string
  ): Promise<{ release: () => Promise<void> }> {
    let release: (() => void) | undefined;
    let settleReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      settleReady = resolve;
    });
    const txDone = target.transaction(async (tx) => {
      await acquireRequestLock(tx, requestId);
      settleReady?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    return {
      release: async () => {
        release?.();
        await txDone;
      },
    };
  }

  it('a second real connection queued behind the same requestId is rejected with 55P03, not left waiting forever', async () => {
    const requestId = randomUUID();
    const held = await holdRequestLock(holderDb, requestId);

    try {
      // ⚠ THIS IS THE R2 MUTATION TARGET. Delete `_shared/request-lock.ts`'s
      // `SET LOCAL lock_timeout = '3s'` line entirely (not just the R1(a) reset) and this
      // promise never rejects — it waits on the held lock indefinitely instead, and this
      // assertion goes RED by exceeding this test's own timeout, since nothing ever settles.
      await expect(
        waiterDb.transaction((tx) => acquireRequestLock(tx, requestId))
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await held.release();
    }
  }, 10_000);
});
