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
      // ⚠ BAL-559 INTERACTION — CORRECTED (see `_shared/request-lock.ts`'s "WHAT `DEFAULT` DOES
      // NOT COVER" section for the full, empirically-settled argument; the sibling
      // `describe('acquireRequestLock — DEFAULT vs startup-packet and mid-session SET …')` block
      // below is where that measurement is pinned as a real assertion). This capture is taken
      // from the SAME production client module (`../../client`) that a future BAL-559 global
      // `lock_timeout` would configure. IF BAL-559 lands it via `connection: { lock_timeout: … }`
      // startup-packet options — the natural idiom — `shownBefore` would start reflecting that
      // value, and `shownAfter` would too, because `DEFAULT` DOES restore a startup-packet value
      // (measured: it becomes `reset_val`). This assertion would keep passing. It would only go
      // RED if BAL-559 (or a future pooler) instead sets `lock_timeout` via a mid-session
      // `onconnect`/on-checkout `SET` issued after connect — that shape does NOT update
      // `reset_val`, so `DEFAULT` would defeat it silently. That red would be EXPECTED and
      // CORRECT — proof the reset no longer restores the connection's real prior value — and the
      // fix at that point is to switch the reset in `acquireRequestLock` from `SET LOCAL
      // lock_timeout = DEFAULT` to a captured-and-restored `set_config('lock_timeout', <captured
      // value>, true)`, which (unlike `SET`) accepts a bind parameter.
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
 * ⚠⚠ SETTLES, EMPIRICALLY, THE "WHAT `DEFAULT` DOES NOT COVER" QUESTION IN `_shared/request-
 * lock.ts`'s docblock — this question has had four prose-only revisions across three commits with
 * no test behind any of them; this block is that test. A reviewer argued from GUC semantics
 * (`RESET`'s docs list "command-line options" as a `reset_val` source, and postgres-js sends
 * `connection: {…}` options in the StartupMessage, which Postgres treats the same as a `-c`
 * option) that a prior revision of the docblock was wrong to claim a startup-packet value is
 * "reset PAST, not restored" by `SET LOCAL … = DEFAULT`. The reviewer was explicit they had not
 * run it. This measures both halves directly, against a real Postgres instance via
 * `createConcurrentDb` (a second, genuinely separate connection from the standard harness's
 * single-tx pool, matching how a real `connection: {…}` option or `onconnect` hook would apply).
 *
 * Uses `pg_settings` (`setting`, `reset_val`, `source`), not just `SHOW`, because `reset_val` is
 * the actual mechanism `RESET`/`SET … = DEFAULT` reads from — inspecting it directly is what makes
 * this a measurement of the mechanism, not just an assertion about this one call's outcome.
 */
describe('acquireRequestLock — DEFAULT vs startup-packet and mid-session SET (fix round, empirical)', () => {
  it('a startup-packet (connection option) lock_timeout IS restored by DEFAULT', async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (url === undefined || url.length === 0) {
      throw new Error(
        'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
      );
    }
    const { db: cfgDb, client } = createConcurrentDb(url, { connection: { lock_timeout: '7s' } });
    try {
      const settingRows = (await cfgDb.execute(
        sql`SELECT setting, reset_val, source FROM pg_settings WHERE name = 'lock_timeout'`
      )) as unknown as Array<{ setting: string; reset_val: string; source: string }>;
      const [settingRow] = settingRows;
      if (settingRow === undefined) throw new Error('pg_settings returned no row');

      // MEASURED: a startup-packet value becomes `reset_val`, with `source = 'client'` — Postgres
      // treats it exactly like a `-c` command-line option, per `RESET`'s own documented sources.
      expect(settingRow.setting).toBe('7000');
      expect(settingRow.reset_val).toBe('7000');
      expect(settingRow.source).toBe('client');

      const requestId = randomUUID();
      const afterRows = await cfgDb.transaction(async (tx) => {
        await acquireRequestLock(tx, requestId);
        // ⚠ MUTATION TARGET. Delete `_shared/request-lock.ts`'s trailing `SET LOCAL
        // lock_timeout = DEFAULT` line and this reads back `'3s'` (the gate's own bound, never
        // reset) instead of `'7s'`.
        return (await tx.execute(sql`SHOW lock_timeout`)) as unknown as Array<{
          lock_timeout: string;
        }>;
      });
      const [afterRow] = afterRows;
      if (afterRow === undefined) throw new Error('SHOW lock_timeout returned no row');

      // MEASURED: RESTORED, not defeated — the startup-packet value survives the DEFAULT reset.
      expect(afterRow.lock_timeout).toBe('7s');
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('an explicit mid-session SET (onconnect-hook / pooler-checkout analog) is NOT restored by DEFAULT', async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (url === undefined || url.length === 0) {
      throw new Error(
        'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
      );
    }
    const { db: cfgDb, client } = createConcurrentDb(url, {});
    try {
      // Simulates a postgres-js `onconnect` hook or a pooler's on-checkout `SET`: an explicit SET
      // issued on the connection AFTER connect, outside any transaction — the ONE mechanism the
      // docblock now names as genuinely uncovered.
      await cfgDb.execute(sql`SET lock_timeout = '9s'`);

      const settingRows = (await cfgDb.execute(
        sql`SELECT setting, reset_val, source FROM pg_settings WHERE name = 'lock_timeout'`
      )) as unknown as Array<{ setting: string; reset_val: string; source: string }>;
      const [settingRow] = settingRows;
      if (settingRow === undefined) throw new Error('pg_settings returned no row');

      // MEASURED: a mid-session SET does NOT update `reset_val` — it reverts to Postgres's
      // compiled-in default (`0`), not the `9s` this session actually has in effect.
      expect(settingRow.setting).toBe('9000');
      expect(settingRow.reset_val).toBe('0');
      expect(settingRow.source).toBe('session');

      const requestId = randomUUID();
      const afterRows = await cfgDb.transaction(async (tx) => {
        await acquireRequestLock(tx, requestId);
        return (await tx.execute(sql`SHOW lock_timeout`)) as unknown as Array<{
          lock_timeout: string;
        }>;
      });
      const [afterRow] = afterRows;
      if (afterRow === undefined) throw new Error('SHOW lock_timeout returned no row');

      // MEASURED: DEFEATED — the session's real `9s` is silently lost, replaced by the compiled-in
      // default. This is the residual gap the docblock's `set_config` remedy exists for, and it
      // stays inert only because nothing in this codebase issues a mid-session SET today.
      expect(afterRow.lock_timeout).toBe('0');
    } finally {
      await client.end({ timeout: 5 });
    }
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
