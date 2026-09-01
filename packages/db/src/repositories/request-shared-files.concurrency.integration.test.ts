import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../schema';
import { _setDb, type Database } from '../client';
import type { DbExecutor } from './_shared/db-executor';
import {
  expertDraftFactory,
  requestExpertRelationshipFactory,
  userFactory,
} from '../test/factories';
import { markNotSelectedByAward } from './request-expert-relationships';
import { requestSharedFilesRepository } from './request-shared-files';

/**
 * ⚠ THE WRITE-SKEW PROOF FOR ADR-1048 §7 INVARIANT 4 — "a closed track never gains new
 * visibility" — WITH TWO GENUINELY SIMULTANEOUS POSTGRES CONNECTIONS.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `request-shared-files.integration.test.ts`. That suite
 * proves `share()` REJECTS a grant target that is ALREADY closed in its own snapshot. It cannot
 * reach the case that actually breaks the invariant in production, because the harness holds a
 * `max: 1` pool inside ONE open transaction (`test/setup-integration.ts`) — two connections are
 * inexpressible there, and a closure written on that same connection is trivially visible to the
 * share. The dangerous interleaving is the opposite one:
 *
 *   1. `share()` reads the track standings and sees the target LIVE (it is — nothing has
 *      committed yet), passes its in-transaction re-validation, and INSERTS the grant;
 *   2. concurrently, `markNotSelectedByAward` (kickoff) UPDATEs that very relationship row;
 *   3. under READ COMMITTED the two transactions touch DIFFERENT TABLES —
 *      `request_file_grants` vs `request_expert_relationships` — so with a plain unlocked
 *      `SELECT` in step 1 they DO NOT CONFLICT and BOTH COMMIT. The result is a live grant
 *      created after its track closed, which `requestFileVisibleToTrack` then honours
 *      UNCONDITIONALLY (its `grants` arm has no closure check, precisely because "every grant is
 *      pre-closure by construction"). A losing candidate reads a contract awarded to a rival.
 *
 * `loadTrackRefs(..., { lockForShare: true })` is what makes step 3 impossible: the `SELECT …
 * FOR SHARE` takes a row lock the closing `UPDATE` must wait for, so the two transactions are
 * forced into an order and the loser observes the winner's committed state.
 *
 * ⚠ IF THESE GO RED AFTER YOU TOUCHED `loadTrackRefs`: the first case pins the MECHANISM (the
 * closer must BLOCK on the share's lock, observed through `pg_blocking_pids`, not assumed).
 * Deleting the `.for('share')` makes it fail with "never blocked" — which is the point.
 *
 * ⚠ EVERY ROW HERE IS COMMITTED, OUTSIDE THE HARNESS TRANSACTION. Rows written inside that
 * transaction are invisible to any other connection. Seeding therefore points the module-level
 * `db` at the warden connection for the duration of the factory calls (`_setDb`), and cleanup is
 * explicit — the harness's rollback neither helps nor hinders.
 */

type PgClient = ReturnType<typeof postgres>;

/** Poll budget for "is the closer blocked yet?". 400 × 25ms = 10s, inside the 30s timeout. */
const BLOCK_POLL_INTERVAL_MS = 25;
const BLOCK_POLL_ATTEMPTS = 400;

/**
 * Three independent connections, each its own Postgres backend:
 *   · `sharer` — runs `share()` and (in the forced case) holds its transaction open;
 *   · `closer` — runs `markNotSelectedByAward`, which must block and then lose the race;
 *   · `warden` — seeds committed fixtures, observes `pg_blocking_pids`, asserts, cleans up.
 *
 * `max: 1` on each so a connection IS a backend — postgres.js queues on the single socket
 * instead of silently opening a second one, which would make "the transaction is open" untrue.
 */
let sharerClient: PgClient;
let closerClient: PgClient;
let wardenClient: PgClient;
let sharerDb: Database;
let closerDb: Database;
let wardenDb: Database;
let sharerPid: number;
let closerPid: number;

/** Held transactions still open, so a failed assertion cannot strand a row lock. */
const openHolds: Array<() => Promise<void>> = [];
/** Statements ISSUED BUT NOT YET AWAITED, so cleanup can drain them before deleting. */
const inFlight: Array<Promise<unknown>> = [];
/**
 * Every project request this file COMMITS. Deleting it cascades to
 * `request_expert_relationships`, `request_shared_files` and `request_file_grants` — the whole
 * graph this suite actually writes.
 *
 * ⚠ THE ANCILLARY ROWS ARE DELIBERATELY LEFT BEHIND, AND THAT IS A MEASURED CHOICE. The
 * factories also mint users, a company and expert profiles, which do NOT cascade from the
 * request. Deleting them here was tried and REVERTED: a committed `DELETE FROM users` has to
 * take FK-check locks across the ~100 tables that reference `users`, and those contend with the
 * still-open per-test transactions other integration files hold on their own connections — the
 * suite went from 60s to 113 MINUTES, with unrelated files timing out inside `userFactory()`.
 *
 * ⚠ WHAT MAKES THE LEAK SAFE IS THE INVITER'S ROLE, NOT LUCK. The one unscoped assertion in the
 * suite that a leaked row can break is `users.integration.test.ts`'s
 * `findIdsByPlatformRoles(['admin'])` — so `seedCommittedRequest` overrides the relationship
 * factory's default `platformRole: 'admin'` inviter with a PLAIN user. Everything else leaked
 * is `platform_role = 'user'` and dies with the ephemeral container. If you add a factory call
 * here that mints a privileged or otherwise globally-visible row, scope it the same way.
 */
const seededRequestIds: string[] = [];

function contend<T>(statement: Promise<T>): Promise<T> {
  inFlight.push(statement.catch(() => undefined));
  return statement;
}

async function backendPid(client: PgClient): Promise<number> {
  const rows = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const [row] = rows;
  if (row === undefined) throw new Error('pg_backend_pid() returned no row');
  return row.pid;
}

/**
 * Block until Postgres reports `waiterPid` as waiting on a lock HELD BY `holderPid`.
 *
 * ⚠ THIS CALL *IS* THE DETERMINISM — there is nothing to `expect()` afterwards. Its exit
 * condition is the database's own answer to "who is blocking whom". Exhausting the budget
 * THROWS, so a race that failed to materialise fails loudly rather than degrading silently into
 * the sequential case the sibling suite already covers.
 */
async function waitUntilBlockedBy(waiterPid: number, holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < BLOCK_POLL_ATTEMPTS; attempt += 1) {
    const rows = await wardenClient<{ blockers: number[] }[]>`
      select coalesce(pg_blocking_pids(${waiterPid}::int), '{}'::int[]) as blockers
    `;
    const [row] = rows;
    if (row !== undefined && row.blockers.includes(holderPid)) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, BLOCK_POLL_INTERVAL_MS);
    });
  }
  throw new Error(
    `backend ${waiterPid} never blocked on backend ${holderPid} within ` +
      `${BLOCK_POLL_ATTEMPTS * BLOCK_POLL_INTERVAL_MS}ms — the FOR SHARE lock this test proves ` +
      `did not hold (has loadTrackRefs' lockForShare been removed?)`
  );
}

interface HeldTransaction<T> {
  result: T;
  commit: () => Promise<void>;
}

/** Run ONE call inside a transaction on `target` and leave it OPEN, holding its locks. */
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
      txError = error;
      fail?.(error);
    });

  const result = await ready;
  const held: HeldTransaction<T> = {
    result,
    commit: async () => {
      release?.();
      await txSettled;
      if (txError !== undefined) throw txError;
    },
  };
  openHolds.push(held.commit);
  return held;
}

interface Seed {
  projectRequestId: string;
  clientUserId: string;
  winnerRelationshipId: string;
  loserRelationshipId: string;
}

/**
 * Seed ONE COMMITTED request with two live `invited` tracks, visible to every connection.
 *
 * ⚠ `_setDb(wardenDb)` IS THE WHOLE TRICK. The factories are hard-bound to the module-level
 * `db`, which the harness has pointed at its own still-open transaction — rows written there
 * are invisible to `sharerDb` / `closerDb`. Pointing it at the warden connection for the
 * duration commits them. The harness's own `beforeEach` re-points `db` before every test, so
 * nothing here leaks into a sibling test.
 */
async function seedCommittedRequest(): Promise<Seed> {
  _setDb(wardenDb);
  // ⚠ A PLAIN USER AS INVITER, NOT the factory's default `platformRole: 'admin'`. See the
  // cleanup bookkeeping above: a committed admin user is visible to every other suite in the
  // run and breaks the unscoped platform-role query in `users.integration.test.ts`.
  const inviter = await userFactory();
  const first = await requestExpertRelationshipFactory({ invitedByUserId: inviter.id });
  const secondExpert = await expertDraftFactory();
  const second = await requestExpertRelationshipFactory({
    projectRequestId: first.projectRequestId,
    expertProfileId: secondExpert.id,
    invitedByUserId: inviter.id,
  });
  const client = await userFactory();

  seededRequestIds.push(first.projectRequestId);
  return {
    projectRequestId: first.projectRequestId,
    clientUserId: client.id,
    winnerRelationshipId: first.relationship.id,
    loserRelationshipId: second.relationship.id,
  };
}

function shareInput(
  seed: Seed,
  grantRelationshipIds: readonly string[]
): Parameters<typeof requestSharedFilesRepository.share>[0] {
  return {
    projectRequestId: seed.projectRequestId,
    uploadedByUserId: seed.clientUserId,
    side: 'client',
    audience: 'grants',
    expertRelationshipId: null,
    grantRelationshipIds,
    r2Key: `request-files/${seed.projectRequestId}/${seed.clientUserId}/${randomUUID()}`,
    fileName: 'nda-gated-contract.pdf',
    contentType: 'application/pdf',
    sizeBytes: 24_576,
  };
}

/** Live grants of a file, as any OTHER connection can see them — i.e. what got committed. */
async function committedGrantIds(fileId: string): Promise<string[]> {
  const rows = await wardenDb
    .select({ relationshipId: schema.requestFileGrants.relationshipId })
    .from(schema.requestFileGrants)
    .where(eq(schema.requestFileGrants.fileId, fileId));
  return rows.map((r) => r.relationshipId);
}

async function notSelectedAtOf(relationshipId: string): Promise<Date | null> {
  const [row] = await wardenDb
    .select({ notSelectedAt: schema.requestExpertRelationships.notSelectedAt })
    .from(schema.requestExpertRelationships)
    .where(eq(schema.requestExpertRelationships.id, relationshipId));
  if (row === undefined) throw new Error(`relationship ${relationshipId} not visible as committed`);
  return row.notSelectedAt;
}

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
    );
  }
  sharerClient = postgres(url, { max: 1 });
  closerClient = postgres(url, { max: 1 });
  wardenClient = postgres(url, { max: 1 });
  sharerDb = drizzle(sharerClient, { schema });
  closerDb = drizzle(closerClient, { schema });
  wardenDb = drizzle(wardenClient, { schema });

  sharerPid = await backendPid(sharerClient);
  closerPid = await backendPid(closerClient);

  // ⚠ THE PREMISE OF THE FILE, ASSERTED. Collapsed onto one backend, `pg_blocking_pids` — which
  // never names a backend as blocking ITSELF — would burn the poll budget and blame the lock.
  expect(new Set([sharerPid, closerPid]).size).toBe(2);
});

afterEach(async () => {
  // ⚠ ORDER IS LOAD-BEARING. Release stranded holds first (or the DELETE blocks on their locks),
  // then drain contenders (or a woken statement lands a row after the delete), then delete.
  for (const commit of openHolds.splice(0)) {
    await commit().catch(() => undefined);
  }
  await Promise.allSettled(inFlight.splice(0));

  const requestIds = seededRequestIds.splice(0);
  if (requestIds.length === 0) return;

  /**
   * ⚠⚠ THE AUDIT ROWS FIRST, AND THIS IS NOT OPTIONAL BOOKKEEPING. `audit_events` has NO FK to
   * `request_shared_files` (by design — it outlives what it records), so the request delete
   * below does NOT cascade to it. `request-shared-files.integration.test.ts`'s
   * "writes no audit row when the caller transaction rolls back" case asserts
   * `entity_type = 'request_shared_file'` is GLOBALLY EMPTY — an unscoped query — so a single
   * committed audit row from this file makes that suite fail whenever it happens to run
   * afterwards in the same worker. Observed, not theoretical.
   *
   * Deleting `audit_events` is safe here in a way deleting `users` was not: it is a leaf table
   * nothing references, so there are no FK-check locks to contend with other files' open
   * transactions.
   */
  const files = await wardenDb
    .select({ id: schema.requestSharedFiles.id })
    .from(schema.requestSharedFiles)
    .where(inArray(schema.requestSharedFiles.projectRequestId, requestIds))
    .catch(() => []);
  if (files.length > 0) {
    await wardenDb
      .delete(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityType, 'request_shared_file'),
          inArray(
            schema.auditEvents.entityId,
            files.map((f) => f.id)
          )
        )
      )
      .catch(() => undefined);
  }

  await wardenDb
    .delete(schema.projectRequests)
    .where(inArray(schema.projectRequests.id, requestIds))
    .catch(() => undefined);
});

afterAll(async () => {
  await Promise.all([
    sharerClient?.end({ timeout: 5 }),
    closerClient?.end({ timeout: 5 }),
    wardenClient?.end({ timeout: 5 }),
  ]);
});

describe('requestSharedFilesRepository.share × markNotSelectedByAward — real concurrency', () => {
  /**
   * ⚠ THE INVARIANT-4 PROOF. `share()` holds `FOR SHARE` on the two relationship rows; the
   * concurrent kickoff closure must therefore BLOCK rather than commit alongside it. That the
   * closure blocks is OBSERVED through `pg_blocking_pids`, not assumed — and it is the whole
   * assertion, because without the lock the two transactions touch different tables and both
   * would commit, leaving the loser holding a grant minted after it closed.
   *
   * The share wins here (it committed first), so the loser DOES hold a grant — legitimately,
   * because at the instant of the share it was live. What matters is that the two writes were
   * SERIALISED, so no third state exists where the closure landed first and the grant was still
   * created.
   */
  it('a kickoff closure BLOCKS on the share’s FOR SHARE lock instead of committing alongside it', async () => {
    const seed = await seedCommittedRequest();

    const held = await holdOpen(sharerDb, (tx) =>
      requestSharedFilesRepository.share(shareInput(seed, [seed.loserRelationshipId]), tx)
    );
    expect(held.result.grants.map((g) => g.relationshipId)).toEqual([seed.loserRelationshipId]);

    // Issued, NOT awaited — it must be in flight and blocked before the sharer commits.
    const closing = contend(
      closerDb.transaction((tx) =>
        markNotSelectedByAward(tx, {
          projectRequestId: seed.projectRequestId,
          winningRelationshipId: seed.winnerRelationshipId,
          at: new Date(),
        })
      )
    );

    // THE GATE IS THE CALL, NOT AN `expect`. It returns only once Postgres names the sharer's
    // backend as the blocker, and throws otherwise. Remove `.for('share')` and this is where it
    // fails.
    await waitUntilBlockedBy(closerPid, sharerPid);

    await held.commit();

    expect(await closing).toEqual([seed.loserRelationshipId]);
    expect(await committedGrantIds(held.result.file.id)).toEqual([seed.loserRelationshipId]);
    expect(await notSelectedAtOf(seed.loserRelationshipId)).not.toBeNull();
  });

  /**
   * THE OTHER ORDERING, and the one that would have been the leak. The kickoff closure holds its
   * `UPDATE`'s row lock open; `share()`'s `SELECT … FOR SHARE` must then BLOCK — which is what
   * makes it see `not_selected_at` once the closure commits, fail its in-transaction
   * re-validation, and ROLL THE WHOLE SHARE BACK.
   *
   * ⚠ WITHOUT THE LOCK THIS TEST IS THE BUG: the unlocked `SELECT` would read the pre-closure
   * snapshot, see the track LIVE, and commit a grant to a track that is closed by the time
   * anyone reads it. The assertion below — the throw, AND zero committed rows for the file — is
   * exactly the difference.
   */
  it('a share that BLOCKS on an in-flight closure rolls back — no grant to a track closed underneath it', async () => {
    const seed = await seedCommittedRequest();

    const held = await holdOpen(closerDb, (tx) =>
      markNotSelectedByAward(tx, {
        projectRequestId: seed.projectRequestId,
        winningRelationshipId: seed.winnerRelationshipId,
        at: new Date(),
      })
    );
    expect(held.result).toEqual([seed.loserRelationshipId]);

    const input = shareInput(seed, [seed.loserRelationshipId]);
    // ⚠ WRAPPED EXPLICITLY. `share(input, exec)` does NOT self-wrap when given an executor, and
    // a bare `Database` autocommits each statement — the rollback this case asserts would not
    // exist. The transaction must be the sharer's own, not the harness's.
    const sharing = contend(
      sharerDb.transaction((tx) => requestSharedFilesRepository.share(input, tx))
    );

    await waitUntilBlockedBy(sharerPid, closerPid);
    await held.commit();

    await expect(sharing).rejects.toThrow('Request track is not live for files');

    // The rollback is total: no file row, therefore no grant, therefore no audit row.
    const files = await wardenDb
      .select({ id: schema.requestSharedFiles.id })
      .from(schema.requestSharedFiles)
      .where(eq(schema.requestSharedFiles.r2Key, input.r2Key));
    expect(files).toEqual([]);
  });
});
