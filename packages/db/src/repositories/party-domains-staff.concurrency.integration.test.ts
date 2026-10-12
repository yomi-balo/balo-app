import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type postgres from 'postgres';
import * as schema from '../schema';
import { _setDb, type Database } from '../client';
import { createConcurrentDb } from '../test/concurrent-client';
import { companyFactory, userFactory } from '../test/factories';
import { partyDomainsRepository } from './party-domains';
import { partyDomainsStaffRepository } from './party-domains-staff';

/**
 * Real-interleaving proof for the staff reassign (BAL-594). Each contender runs on its own
 * Postgres backend and COMMITS; the gate backend holds a row lock on the live domain row so
 * both contenders are provably parked behind it before either may proceed. Blocking is
 * observed through `pg_blocking_pids` polling, never a sleep: exhausting the budget throws.
 */

type PgClient = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const BLOCK_POLL_INTERVAL_MS = 25;
const BLOCK_POLL_ATTEMPTS = 800;
const REASON = 'Concurrency proof';

let gateClient: PgClient;
let aClient: PgClient;
let bClient: PgClient;
let wardenClient: PgClient;
let gateDb: Database;
let aDb: Database;
let bDb: Database;
let wardenDb: Database;
let gatePid: number;
let aPid: number;
let bPid: number;

const openHolds: Array<() => Promise<void>> = [];
const inFlight: Array<Promise<unknown>> = [];
const seededCompanyIds: string[] = [];

async function backendPid(client: PgClient): Promise<number> {
  const rows = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const [row] = rows;
  if (row === undefined) throw new Error('pg_backend_pid() returned no row');
  return row.pid;
}

/**
 * Poll until Postgres reports `waiterPid` blocked by any of `holderPids`; THROWS on exhaustion.
 * A second tuple-lock waiter queues behind the FIRST waiter, not behind the lock holder, so the
 * later contender names the earlier one as its blocker.
 */
async function waitUntilBlockedBy(waiterPid: number, holderPids: readonly number[]): Promise<void> {
  for (let attempt = 0; attempt < BLOCK_POLL_ATTEMPTS; attempt += 1) {
    const rows = await wardenClient<{ blockers: number[] }[]>`
      select coalesce(pg_blocking_pids(${waiterPid}::int), '{}'::int[]) as blockers
    `;
    const [row] = rows;
    if (row !== undefined && row.blockers.some((pid) => holderPids.includes(pid))) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, BLOCK_POLL_INTERVAL_MS);
    });
  }
  throw new Error(
    `backend ${waiterPid} never blocked on backend(s) ${holderPids.join(',')} within ` +
      `${BLOCK_POLL_ATTEMPTS * BLOCK_POLL_INTERVAL_MS}ms — the interleaving was not forced`
  );
}

/** Run `run` in a transaction on `target` and leave it OPEN, holding its locks. */
async function holdOpen(
  target: Database,
  run: (tx: Tx) => Promise<unknown>
): Promise<{ commit: () => Promise<void> }> {
  let release: (() => void) | undefined;
  let fail: ((reason: unknown) => void) | undefined;
  let settle: (() => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let txError: unknown;
  const txSettled = target
    .transaction(async (tx) => {
      await run(tx);
      settle?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    })
    .catch((error: unknown) => {
      txError = error;
      fail?.(error);
    });
  await ready;
  const held = {
    commit: async (): Promise<void> => {
      release?.();
      await txSettled;
      if (txError !== undefined) throw txError;
    },
  };
  openHolds.push(held.commit);
  return held;
}

/**
 * `db` is a live ES binding read when the repository calls `db.transaction(`, and each
 * writer under test reaches that call with no `await` before it, so binding `target`
 * immediately before the call is synchronous and race-free.
 */
function runOn<T>(target: Database, call: () => Promise<T>): Promise<T> {
  _setDb(target);
  const pending = call();
  inFlight.push(pending.catch(() => undefined));
  return pending;
}

async function seedParties(): Promise<{
  staffId: string;
  owner: string;
  targetB: string;
  targetC: string;
  rowId: string;
}> {
  _setDb(wardenDb);
  const staff = await userFactory();
  const [owner, targetB, targetC] = await Promise.all([
    companyFactory(),
    companyFactory(),
    companyFactory(),
  ]);
  seededCompanyIds.push(owner.id, targetB.id, targetC.id);
  const [row] = await wardenDb
    .insert(schema.partyDomains)
    .values({
      partyType: 'company',
      partyId: owner.id,
      domain: `race-${owner.id}.com`,
      source: 'auto_captured',
      createdByUserId: staff.id,
    })
    .returning();
  if (row === undefined) throw new Error('seed row insert failed');
  return {
    staffId: staff.id,
    owner: owner.id,
    targetB: targetB.id,
    targetC: targetC.id,
    rowId: row.id,
  };
}

async function liveRowsFor(
  domainOwnerId: string
): Promise<(typeof schema.partyDomains.$inferSelect)[]> {
  return wardenDb
    .select()
    .from(schema.partyDomains)
    .where(
      and(
        eq(schema.partyDomains.domain, `race-${domainOwnerId}.com`),
        isNull(schema.partyDomains.deletedAt)
      )
    );
}

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
    );
  }
  ({ db: gateDb, client: gateClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: aDb, client: aClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: bDb, client: bClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: wardenDb, client: wardenClient } = createConcurrentDb(url, { max: 1 }));

  gatePid = await backendPid(gateClient);
  aPid = await backendPid(aClient);
  bPid = await backendPid(bClient);
  expect(new Set([gatePid, aPid, bPid]).size).toBe(3);
});

afterEach(async () => {
  for (const commit of openHolds.splice(0)) {
    await commit().catch(() => undefined);
  }
  await Promise.allSettled(inFlight.splice(0));

  const companyIds = seededCompanyIds.splice(0);
  if (companyIds.length === 0) return;
  const rows = await wardenDb
    .select({ id: schema.partyDomains.id })
    .from(schema.partyDomains)
    .where(inArray(schema.partyDomains.partyId, companyIds))
    .catch(() => []);
  if (rows.length > 0) {
    await wardenDb
      .delete(schema.auditEvents)
      .where(
        inArray(
          schema.auditEvents.entityId,
          rows.map((r) => r.id)
        )
      )
      .catch(() => undefined);
  }
  await wardenDb
    .delete(schema.partyDomains)
    .where(inArray(schema.partyDomains.partyId, companyIds))
    .catch(() => undefined);
  await wardenDb
    .delete(schema.companies)
    .where(inArray(schema.companies.id, companyIds))
    .catch(() => undefined);
});

afterAll(async () => {
  await Promise.all([
    gateClient?.end({ timeout: 5 }),
    aClient?.end({ timeout: 5 }),
    bClient?.end({ timeout: 5 }),
    wardenClient?.end({ timeout: 5 }),
  ]);
});

describe('partyDomainsStaffRepository.reassignDomain — concurrent', () => {
  it('two reassigns of one row, both parked behind a row lock: exactly one reassigned, one stale, one live owner', async () => {
    const seed = await seedParties();
    const held = await holdOpen(gateDb, (tx) =>
      tx
        .select()
        .from(schema.partyDomains)
        .where(eq(schema.partyDomains.id, seed.rowId))
        .for('update')
    );

    const expected = { domainId: seed.rowId, partyType: 'company', partyId: seed.owner } as const;
    const toB = runOn(aDb, () =>
      partyDomainsStaffRepository.reassignDomain({
        expected,
        to: { partyType: 'company', partyId: seed.targetB },
        actorUserId: seed.staffId,
        reason: REASON,
      })
    );
    await waitUntilBlockedBy(aPid, [gatePid]);
    const toC = runOn(bDb, () =>
      partyDomainsStaffRepository.reassignDomain({
        expected,
        to: { partyType: 'company', partyId: seed.targetC },
        actorUserId: seed.staffId,
        reason: REASON,
      })
    );
    await waitUntilBlockedBy(bPid, [gatePid, aPid]);

    await held.commit();
    const outcomes = (await Promise.all([toB, toC])).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['reassigned', 'stale']);

    const live = await liveRowsFor(seed.owner);
    expect(live).toHaveLength(1);
    expect([seed.targetB, seed.targetC]).toContain(live[0]?.partyId);

    const audits = await wardenDb
      .select()
      .from(schema.auditEvents)
      .where(
        inArray(schema.auditEvents.action, [
          'party_domain.staff_added',
          'party_domain.staff_removed',
        ])
      );
    const mine = audits.filter((a) => a.actorUserId === seed.staffId);
    expect(mine).toHaveLength(2);
  });

  it('a signup capture against the still-live old row, before a parked reassign writes, leaves the reassign target as the single live owner', async () => {
    const seed = await seedParties();
    const held = await holdOpen(gateDb, (tx) =>
      tx
        .select()
        .from(schema.partyDomains)
        .where(eq(schema.partyDomains.id, seed.rowId))
        .for('update')
    );

    const reassign = runOn(aDb, () =>
      partyDomainsStaffRepository.reassignDomain({
        expected: { domainId: seed.rowId, partyType: 'company', partyId: seed.owner },
        to: { partyType: 'company', partyId: seed.targetB },
        actorUserId: seed.staffId,
        reason: REASON,
      })
    );
    await waitUntilBlockedBy(aPid, [gatePid]);

    const capture = await runOn(bDb, () =>
      bDb.transaction((tx) =>
        partyDomainsRepository.capture(
          {
            partyType: 'company',
            partyId: seed.targetC,
            domain: `race-${seed.owner}.com`,
            actorUserId: seed.staffId,
          },
          tx
        )
      )
    );
    expect(capture).toEqual({ outcome: 'skipped', reason: 'already_claimed' });

    await held.commit();
    await expect(reassign).resolves.toMatchObject({ outcome: 'reassigned' });

    const live = await liveRowsFor(seed.owner);
    expect(live).toHaveLength(1);
    expect(live[0]?.partyId).toBe(seed.targetB);
  });
});
