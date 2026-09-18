import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  PLATFORM_CAPABILITIES,
  PLATFORM_STAFF_ROLES,
  STAFF_ACCESS_AUDIT_ACTIONS,
  resolvePlatformCapabilities,
  type PlatformCapability,
} from '@balo/shared/authz';
import * as schema from '../schema';
import type { Database } from '../client';
import { createConcurrentDb } from '../test/concurrent-client';
import type { DbExecutor } from './_shared/db-executor';
import { usersRepository, type PlatformRole, type SaveStaffAccessInput } from './users';

/**
 * ⚠⚠ BAL-561 — THE STAFF-MANAGEMENT FLOOR UNDER REAL CONCURRENCY, ON GENUINELY SIMULTANEOUS
 * POSTGRES BACKENDS. Acceptance: "Two concurrent saves that each remove a different last holder of
 * `manage_staff_capabilities`: exactly one commits."
 *
 * WHY A SEPARATE FILE. `users.staff-access.integration.test.ts` runs every save through the
 * harness's single `max: 1` connection inside one open transaction, so saves can only ever run
 * sequentially there. It proves each RULE; it cannot prove the rules survive two saves that
 * overlap.
 *
 * WHAT WOULD GO WRONG WITHOUT THE LOCK. Under READ COMMITTED each save's floor check reads a
 * snapshot that cannot see the other's uncommitted demotion. Save 1 demotes holder A ("B still
 * holds"), save 2 demotes holder B ("A still holds"); the two UPDATEs touch DIFFERENT rows so
 * neither waits on the other, both commit, and nobody can manage staff. `saveStaffAccess` closes
 * that by taking `SELECT … FOR NO KEY UPDATE` on every staff row (plus target and actor) BEFORE it
 * evaluates: the second save blocks on the first, and when it wakes the lock read has re-read the
 * winner's committed rows (EvalPlanQual), so its floor check sees A already demoted.
 *
 * THE CASES, and why there are three (P1, P5):
 *   1. THE PURE FLOOR RACE. The actor is a super_admin whose list holds `manage_staff_capabilities`
 *      but not `view_platform_admin`: authorised to save, but NOT a floor holder (D2), and not
 *      either target. So the actor re-check passes on both sides and the FLOOR is the only rule
 *      that can refuse the loser. This is the case that carries the acceptance criterion.
 *   2. THE REALISTIC RACE — mutual demotion. A demotes B while B demotes A. D3 forbids self-edits,
 *      so each actor is the other's target, and the loser is refused by the in-transaction ACTOR
 *      RE-CHECK (its actor was demoted under the lock), before the floor is even reached.
 *   3. THE LOCK DOES NOT STALL FK CHILDREN (P1). While a save holds its lock, an insert that
 *      references a locked staff row (an audit event with that staff member as actor) must NOT
 *      block. `FOR UPDATE` would block it (it conflicts with the `FOR KEY SHARE` Postgres's RI
 *      trigger takes on the parent row); `FOR NO KEY UPDATE` does not.
 *
 * ⚠⚠ MUTATION PROOFS (verified by editing `saveStaffAccess` and running this file):
 *   · delete `.for('no key update')` → case 1 goes red: the loser never blocks on the lock read.
 *   · change it to `.for('update')` → case 3 goes red: the child insert is observed blocked on
 *     the held save.
 *
 * ⚠ DEPENDS ON READ COMMITTED, the Postgres default and the testcontainer's setting.
 *
 * DETERMINISM. Nothing waits a fixed interval and hopes. The forced cases hold the winner's
 * transaction OPEN and poll `pg_blocking_pids()` (and `pg_stat_activity.query`) until Postgres
 * itself reports the loser blocked BY the winner ON the lock read, and only then commit the winner.
 * Case 3's "did not block" is an absence, so it is observed both ways: the insert completing, or
 * Postgres naming the winner as its blocker (a failure) — and then proven non-vacuous by a
 * conflicting request from the same backend that DOES block.
 *
 * HARNESS RELATIONSHIP. `setupFiles` still opens its per-test transaction on the shared client;
 * NOTHING BELOW USES IT, or any factory (factories are hard-wired to the harness `db`, and rows
 * written there are invisible to other backends — memory
 * `reference_db_integration_harness_no_concurrency`). Every row is written, read and deleted
 * through the three clients below, and cleaned up explicitly. The shape of this file — `contend`,
 * `holdOpen`, `waitUntilBlockedBy`, the drains — follows `reviews.concurrency.integration.test.ts`.
 */

type PgClient = ReturnType<typeof createConcurrentDb>['client'];

/** Every user this file commits carries this prefix, so cleanup can be exact. */
const EMAIL_PREFIX = 'staff-access-concurrency-';

/** Poll budget for "is the loser blocked yet?". 400 × 25ms = 10s, inside the 30s timeout. */
const BLOCK_POLL_INTERVAL_MS = 25;
const BLOCK_POLL_ATTEMPTS = 400;

/**
 * The SQL text of `saveStaffAccess`'s lock read. Drizzle emits `select … from "users" where … order
 * by "users"."id" asc for no key update`, and postgres-js sends it verbatim (parameters ride
 * separately), so `pg_stat_activity.query` reports it exactly. The save's other statements — the
 * `update` and the audit `insert` — cannot match it, which is what pins that the loser blocks on
 * the LOCK READ, i.e. before it evaluates anything.
 *
 * ⚠ IF THE LOCK STRENGTH CHANGES, THIS CHANGES WITH IT — otherwise case 1 degrades into a
 * permanent "never observed".
 */
const LOCK_READ_PATTERN = /^\s*select\b[\s\S]*\bfor\s+no\s+key\s+update\b\s*$/i;

const CAP = PLATFORM_CAPABILITIES;

/**
 * Three independent connections, each its own backend (`max: 1`, so a connection IS a backend):
 *   · `winner` — runs the first save and holds its transaction open;
 *   · `loser`  — the contending save (or child insert), which must block — or must not;
 *   · `warden` — seeds, observes `pg_blocking_pids`, asserts committed state, cleans up.
 * `createConcurrentDb` keeps `prepare: false`, the production driver setting.
 */
let winnerClient: PgClient;
let loserClient: PgClient;
let wardenClient: PgClient;
let winnerDb: Database;
let loserDb: Database;
let wardenDb: Database;
let winnerPid: number;
let loserPid: number;

/** Ids this file committed, for the `afterEach` teardown. */
const seededUserIds: string[] = [];

/** Held transactions still open, so a failed assertion cannot strand a row lock. */
const openHolds: Array<() => Promise<void>> = [];

/**
 * Issued-but-not-awaited statements, so cleanup waits for them before deleting — a woken contender
 * must not land a row after the deletes. Registering also attaches a handler, so a rejected
 * contender cannot surface as an unhandled rejection after this file has moved on.
 */
const inFlight: Array<Promise<unknown>> = [];

function contend<T>(statement: Promise<T>): Promise<T> {
  inFlight.push(statement.catch(() => undefined));
  return statement;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function backendPid(client: PgClient): Promise<number> {
  const rows = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const [row] = rows;
  if (row === undefined) {
    throw new Error('pg_backend_pid() returned no row');
  }
  return row.pid;
}

async function blockersOf(waiterPid: number): Promise<{ blockers: number[]; query: string }> {
  const rows = await wardenClient<{ blockers: number[]; query: string }[]>`
    select coalesce(pg_blocking_pids(${waiterPid}::int), '{}'::int[]) as blockers,
           coalesce((select query from pg_stat_activity where pid = ${waiterPid}::int), '') as query
  `;
  const [row] = rows;
  return row ?? { blockers: [], query: '' };
}

/**
 * Return once Postgres reports `waiterPid` blocked by `holderPid` — and, with `onStatement`, blocked
 * while running a statement matching it. Exhausting the budget THROWS, naming what was seen, so a
 * race that failed to materialise fails loudly instead of degrading into the sequential case.
 */
async function waitUntilBlockedBy(
  waiterPid: number,
  holderPid: number,
  onStatement?: { pattern: RegExp; describe: string }
): Promise<void> {
  let lastSeenQuery = '(never observed blocked)';
  for (let attempt = 0; attempt < BLOCK_POLL_ATTEMPTS; attempt += 1) {
    const { blockers, query } = await blockersOf(waiterPid);
    if (blockers.includes(holderPid)) {
      if (onStatement === undefined) return;
      lastSeenQuery = query;
      if (onStatement.pattern.test(query)) return;
    }
    await sleep(BLOCK_POLL_INTERVAL_MS);
  }
  const budgetMs = BLOCK_POLL_ATTEMPTS * BLOCK_POLL_INTERVAL_MS;
  throw new Error(
    `backend ${waiterPid} was never observed blocked on backend ${holderPid}` +
      (onStatement === undefined ? '' : ` while running ${onStatement.describe}`) +
      ` within ${budgetMs}ms. If the last statement is an "update …" or an "insert …", or nothing ` +
      `blocked at all, THE LOCK READ IS MISSING (or no longer precedes evaluation): the save ` +
      `evaluates on an unlocked snapshot and a floor race can commit twice. If it is a ` +
      `"select … for update", the lock was STRENGTHENED — see P1 in saveStaffAccess's docblock.\n` +
      `Last statement seen while blocked: ${lastSeenQuery}`
  );
}

/**
 * Await `statement` (issued on `waiterPid`) while proving it is never blocked by `holderPid`: each
 * poll either sees it settled (pass) or asks Postgres whether the holder is blocking it (a named
 * failure). An observation both ways, not a timeout.
 */
async function expectCompletesUnblocked(
  statement: Promise<unknown>,
  waiterPid: number,
  holderPid: number,
  describe: string
): Promise<void> {
  let settled = false;
  const tracked = statement.finally(() => {
    settled = true;
  });
  contend(tracked);
  for (let attempt = 0; attempt < BLOCK_POLL_ATTEMPTS; attempt += 1) {
    if (settled) {
      await tracked;
      return;
    }
    const { blockers } = await blockersOf(waiterPid);
    if (blockers.includes(holderPid)) {
      throw new Error(
        `${describe} was BLOCKED by the held save (backend ${holderPid}). The staff lock must be ` +
          `FOR NO KEY UPDATE: FOR UPDATE conflicts with the FOR KEY SHARE Postgres's RI trigger ` +
          `takes on users for every child insert, which stalls every audit event, internal note ` +
          `and owner assignment naming any staff member while a save is open (P1).`
      );
    }
    await sleep(BLOCK_POLL_INTERVAL_MS);
  }
  throw new Error(`${describe} neither completed nor blocked within the poll budget`);
}

interface HeldTransaction<T> {
  /** What the repository call inside the still-open transaction returned. */
  result: T;
  /** COMMIT it, and wait for the commit to land. Safe to call more than once. */
  commit: () => Promise<void>;
}

/**
 * Run ONE repository call inside a transaction on `target` and leave that transaction OPEN,
 * holding whatever locks the call took, until `commit()`. `saveStaffAccess` handed a transaction
 * handle opens a SAVEPOINT, and Postgres transfers a released subtransaction's row locks to the
 * parent — so the locks outlive the call's own return, which is what makes this holdable.
 */
async function holdOpen<T>(
  target: Database,
  run: (tx: DbExecutor) => Promise<T>
): Promise<HeldTransaction<T>> {
  let release: (() => void) | undefined;
  let settle: ((value: T) => void) | undefined;
  let fail: ((reason: unknown) => void) | undefined;
  const ready = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  let txError: unknown;
  const txSettled = target
    .transaction(async (tx) => {
      const value = await run(tx);
      settle?.(value);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    })
    .catch((error: unknown) => {
      // Recorded, never re-thrown here: an unawaited rejection would surface as an unhandled
      // rejection if the test failed before reaching `commit()`.
      txError = error;
      fail?.(error);
    });

  const result = await ready;

  const held: HeldTransaction<T> = {
    result,
    commit: async () => {
      release?.();
      await txSettled;
      if (txError !== undefined) {
        throw txError;
      }
    },
  };
  openHolds.push(held.commit);
  return held;
}

/** One COMMITTED user with the given access, visible to every connection. */
async function seedUser(
  role: PlatformRole,
  customList: PlatformCapability[] | null = null
): Promise<string> {
  const unique = randomUUID();
  const [row] = await wardenDb
    .insert(schema.users)
    .values({
      workosId: `${EMAIL_PREFIX}${unique}`,
      email: `${EMAIL_PREFIX}${unique}@test.example`,
      firstName: 'Concurrency',
      lastName: role,
      platformRole: role,
      platformCapabilities: customList,
    })
    .returning({ id: schema.users.id });
  if (row === undefined) {
    throw new Error('user insert failed');
  }
  seededUserIds.push(row.id);
  return row.id;
}

/**
 * The committed state everyone else sees — the fixture for both races. A and B are the two floor
 * holders; X is authorised to manage staff but is NOT a floor holder (no `view_platform_admin`).
 */
async function seedFloorFixture(): Promise<{ a: string; b: string; x: string }> {
  const a = await seedUser('super_admin');
  const b = await seedUser('super_admin');
  const x = await seedUser('super_admin', [CAP.MANAGE_STAFF_CAPABILITIES]);

  // THE PREMISE, ASSERTED: exactly A and B keep the floor among ALL committed live staff. A leaked
  // staff row from another suite would otherwise make case 1 pass for the wrong reason.
  expect((await committedFloorHolders()).sort((p, q) => p.localeCompare(q))).toEqual(
    [a, b].sort((p, q) => p.localeCompare(q))
  );
  return { a, b, x };
}

/**
 * Ids of every committed account keeping the D2 floor, read on the warden.
 *
 * ⚠ D2 IS RESTATED HERE ("active, undeleted, and the resolver grants BOTH tokens") rather than
 * calling `accountKeepsStaffManagementFloor`, so this observation does not share a defect with the
 * code under test.
 */
async function committedFloorHolders(): Promise<string[]> {
  const rows = await wardenDb
    .select({
      id: schema.users.id,
      platformRole: schema.users.platformRole,
      platformCapabilities: schema.users.platformCapabilities,
      status: schema.users.status,
    })
    .from(schema.users)
    .where(
      and(
        inArray(schema.users.platformRole, [...PLATFORM_STAFF_ROLES] as PlatformRole[]),
        isNull(schema.users.deletedAt)
      )
    );
  return rows
    .filter((row) => {
      const resolved = resolvePlatformCapabilities(row.platformRole, row.platformCapabilities);
      return (
        row.status === 'active' &&
        resolved.includes(CAP.MANAGE_STAFF_CAPABILITIES) &&
        resolved.includes(CAP.VIEW_PLATFORM_ADMIN)
      );
    })
    .map((row) => row.id);
}

async function committedRole(userId: string): Promise<PlatformRole> {
  const [row] = await wardenDb
    .select({ platformRole: schema.users.platformRole })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (row === undefined) {
    throw new Error(`user ${userId} not found on the committed view`);
  }
  return row.platformRole;
}

async function committedAuditRowsFor(userId: string): Promise<Array<{ action: string }>> {
  return wardenDb
    .select({ action: schema.auditEvents.action })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.entityId, userId));
}

function demote(actorUserId: string, targetUserId: string): SaveStaffAccessInput {
  return {
    actorUserId,
    targetUserId,
    expected: { role: 'super_admin', customList: null },
    next: { role: 'admin', customList: null },
  };
}

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
    );
  }
  ({ db: winnerDb, client: winnerClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: loserDb, client: loserClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: wardenDb, client: wardenClient } = createConcurrentDb(url, { max: 1 }));

  // Also warms both sockets.
  winnerPid = await backendPid(winnerClient);
  loserPid = await backendPid(loserClient);

  // THE PREMISE OF THE WHOLE FILE: two distinct backends. `pg_blocking_pids` never reports a
  // backend as blocking itself, so collapsing them would read as "never blocked".
  expect(new Set([winnerPid, loserPid]).size).toBe(2);
});

/**
 * Delete everything this file committed. `audit_events.actor_user_id` is ON DELETE RESTRICT, so
 * audit rows go first — both those naming a seeded user as ACTOR and those naming one as ENTITY.
 *
 * ⚠ MUST NOT THROW: the harness's own `afterEach` (registered first, so run last) rolls back its
 * transaction; a throw here leaves that `max: 1` connection pinned and hangs the rest of the run.
 */
async function deleteSeededRows(): Promise<void> {
  const userIds = seededUserIds.splice(0);
  if (userIds.length === 0) return;
  await wardenDb
    .delete(schema.auditEvents)
    .where(
      or(
        inArray(schema.auditEvents.actorUserId, userIds),
        inArray(schema.auditEvents.entityId, userIds)
      )
    );
  await wardenDb.delete(schema.users).where(inArray(schema.users.id, userIds));
}

afterEach(async () => {
  // ⚠ ORDER IS LOAD-BEARING. 1: release any transaction a failed assertion left open, or the
  // deletes block on its locks. 2: let woken contenders finish. 3: only then delete.
  for (const commit of openHolds.splice(0)) {
    await commit().catch(() => undefined);
  }
  await Promise.allSettled(inFlight.splice(0));
  await deleteSeededRows().catch(() => undefined);
});

afterAll(async () => {
  await deleteSeededRows().catch(() => undefined);
  await Promise.all([
    winnerClient?.end({ timeout: 5 }),
    loserClient?.end({ timeout: 5 }),
    wardenClient?.end({ timeout: 5 }),
  ]);
});

describe('usersRepository.saveStaffAccess — two saves that each remove a last floor holder', () => {
  /**
   * ⚠⚠ THE ONE THAT CARRIES THE ACCEPTANCE CRITERION. X demotes A (held open, uncommitted), then X
   * demotes B on a second backend. The loser must block ON THE LOCK READ — asserted through
   * `pg_stat_activity`, which pins that the lock is taken before evaluation — and, once the winner
   * commits, re-read A as demoted and refuse with `floor_violation`. Exactly one demotion commits.
   *
   * Without the lock: the loser evaluates A as still a holder, its UPDATE touches B (a row the
   * winner never locked), it never blocks, and both commit — this case then fails at
   * `waitUntilBlockedBy`, before the outcome assertions could even be reached.
   */
  it('case 1 — the pure floor race: exactly one demotion commits; the loser is refused floor_violation', async () => {
    const { a, b, x } = await seedFloorFixture();

    const held = await holdOpen(winnerDb, (tx) =>
      usersRepository.saveStaffAccess(demote(x, a), tx)
    );
    expect(held.result).toMatchObject({ outcome: 'saved', roleChanged: true });
    // Not yet visible to anyone else.
    expect(await committedRole(a)).toBe('super_admin');

    const contender = contend(usersRepository.saveStaffAccess(demote(x, b), loserDb));

    await waitUntilBlockedBy(loserPid, winnerPid, {
      pattern: LOCK_READ_PATTERN,
      describe: 'the staff-access lock read (select … for no key update)',
    });

    await held.commit();
    expect(await contender).toEqual({ outcome: 'refused', reason: 'floor_violation' });

    expect(await committedRole(a)).toBe('admin');
    expect(await committedRole(b)).toBe('super_admin');
    expect(await committedFloorHolders()).toEqual([b]);
    expect(await committedAuditRowsFor(a)).toEqual([
      { action: STAFF_ACCESS_AUDIT_ACTIONS.ROLE_CHANGED },
    ]);
    await expect(committedAuditRowsFor(b)).resolves.toHaveLength(0);
  });

  /**
   * The realistic race: two holders demoting each other (neither may edit themselves, D3). Forced
   * the same way. The loser's actor (B) is in its own lock set by id, so when it wakes it re-reads
   * B as ALREADY DEMOTED by the winner and the actor re-check refuses it — before the floor.
   */
  it('case 2 — mutual demotion: the winner saves; the loser is refused actor_not_authorized', async () => {
    const { a, b } = await seedFloorFixture();

    const held = await holdOpen(winnerDb, (tx) =>
      usersRepository.saveStaffAccess(demote(a, b), tx)
    );
    expect(held.result).toMatchObject({ outcome: 'saved' });

    const contender = contend(usersRepository.saveStaffAccess(demote(b, a), loserDb));

    await waitUntilBlockedBy(loserPid, winnerPid, {
      pattern: LOCK_READ_PATTERN,
      describe: 'the staff-access lock read (select … for no key update)',
    });

    await held.commit();
    expect(await contender).toEqual({ outcome: 'refused', reason: 'actor_not_authorized' });

    expect(await committedRole(b)).toBe('admin');
    expect(await committedRole(a)).toBe('super_admin');
    await expect(committedAuditRowsFor(b)).resolves.toHaveLength(1);
    await expect(committedAuditRowsFor(a)).resolves.toHaveLength(0);
  });
});

describe('usersRepository.saveStaffAccess — the lock strength (P1)', () => {
  /**
   * While a save holds its lock over every staff row, an audit event naming a LOCKED staff member
   * (B — locked only by the explicit staff lock, never updated by the held save) as its ACTOR must
   * insert without waiting. Then, from the SAME backend, a request that DOES conflict must block on
   * the winner: that is the anti-vacuity step — the lock was live on B the whole time, so the
   * insert's success cannot be explained by the lock having gone away.
   */
  it('case 3 — a held save does NOT block an FK child insert that references a locked staff row', async () => {
    const { a, b, x } = await seedFloorFixture();

    const held = await holdOpen(winnerDb, (tx) =>
      usersRepository.saveStaffAccess(demote(x, a), tx)
    );
    expect(held.result).toMatchObject({ outcome: 'saved' });

    await expectCompletesUnblocked(
      loserDb.insert(schema.auditEvents).values({
        actorUserId: b,
        action: 'test.staff_access_child_insert',
        entityType: 'user',
        entityId: b,
      }),
      loserPid,
      winnerPid,
      'an audit_events insert with a locked staff member as actor'
    );

    // Anti-vacuity: the winner still holds B.
    const conflicting = contend(
      loserDb
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, b))
        .for('no key update')
    );
    await waitUntilBlockedBy(loserPid, winnerPid);

    await held.commit();
    await expect(conflicting).resolves.toHaveLength(1);

    // The child row really landed while the save was uncommitted — a genuine FK-child insert.
    const children = await wardenDb
      .select({ id: schema.auditEvents.id })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.actorUserId, b),
          eq(schema.auditEvents.action, 'test.staff_access_child_insert')
        )
      );
    expect(children).toHaveLength(1);
  });
});
