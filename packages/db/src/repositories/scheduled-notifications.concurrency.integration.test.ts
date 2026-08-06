import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, like } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../schema';
import type { Database } from '../client';
import type { DbExecutor } from './_shared/db-executor';
import { scheduledNotificationsRepository } from './scheduled-notifications';

/**
 * ⚠ THE REAL SEND-ONCE PROOF — TWO GENUINELY SIMULTANEOUS POSTGRES CONNECTIONS.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `scheduled-notifications.integration.test.ts`.
 * That suite's "two claims of the same row → exactly ONE winner" case runs two claims
 * SEQUENTIALLY, on the single `max: 1` connection the harness holds inside one open
 * transaction (`test/setup-integration.ts`). It is a real and necessary test — it proves the
 * conditional `UPDATE`'s `WHERE` rejects an already-claimed row — but it can only ever
 * exercise the predicate against a row it can already SEE. It never exercises the path that
 * actually decides the race in production:
 *
 *   1. the second `UPDATE` finds the row still `pending` IN ITS OWN SNAPSHOT (the winner has
 *      not committed yet), so the predicate PASSES and it proceeds to lock the tuple;
 *   2. it BLOCKS on the winner's row lock — the outcome is undecided at this point;
 *   3. when the winner commits, READ COMMITTED does not abort the loser and does not hand it
 *      the stale tuple: it walks to the winner's newly committed row version and
 *      RE-EVALUATES the `WHERE` against it (EvalPlanQual). Only now — with `status='claimed'`
 *      and a fresh `claimed_at` — does the predicate fail and the row drop out of the update.
 *
 * Step 1–3 is the whole guarantee. The sequential test skips 1 and 2 entirely and asserts 3
 * against a row it can ALREADY SEE as `claimed` in its own snapshot — not against a COMMITTED
 * claimed row, since both of its claims run inside the harness's one still-open transaction, so
 * the first claim's row version is never committed at all. Either way it is a different (easier)
 * question. Everything here therefore uses its OWN postgres clients, OUTSIDE the harness
 * transaction, because rows written inside that transaction are invisible to any other
 * connection and two simultaneous connections cannot be expressed on a `max: 1` pool.
 *
 * ⚠ DEPENDS ON READ COMMITTED, the Postgres default and the testcontainer's setting. The
 * EvalPlanQual walk in step 3 is a READ COMMITTED behaviour: under REPEATABLE READ or higher
 * the loser would instead raise a serialization failure (`40001`), so the contending call would
 * REJECT rather than resolve `undefined` and these tests would fail loudly. If anyone ever sets
 * `default_transaction_isolation` on the test container, that is why.
 *
 * DETERMINISM. Nothing here waits a fixed interval and hopes. The forced-interleaving cases
 * hold the winner's transaction OPEN and then poll `pg_blocking_pids()` until Postgres itself
 * reports the loser as blocked BY the winner's backend — an observed fact, asserted, not a
 * timing assumption — and only then commit the winner. `Promise.all` is used as well, for the
 * unforced form of the same race; that one is genuinely concurrent (both statements are
 * dispatched before either reply is read) but its interleaving is NOT guaranteed — measured
 * locally, it fails to contend at all most of the time, and its name says so — which is
 * exactly why the forced cases exist alongside it and are the ones that carry the proof.
 *
 * ⚠ IF YOU ARE HERE BECAUSE THESE WENT RED AFTER YOU REWROTE `claim` OR `cancel`: they pin the
 * MECHANISM, not only the guarantee. A contender must BLOCK and then lose the recheck, so a
 * `SELECT … FOR UPDATE SKIP LOCKED` implementation would fail `waitUntilBlockedBy` — it skips
 * rather than waits — even though it is also send-once-correct. That over-constraint is
 * deliberate: the blocking-then-recheck path is precisely what the prose above `claim` and
 * `cancel` asserts, so it is what gets tested. But it means a red here is not automatically a
 * bug — decide whether you changed the GUARANTEE or only the MECHANISM, and if only the
 * mechanism, rewrite these cases and those docstrings together.
 *
 * The harness `setupFiles` still runs for this file — its `beforeEach` opens a transaction on
 * the shared client and points the module-level `db` at it. NOTHING BELOW USES THAT `db`, or
 * any factory that does; every row is written, read and deleted through the clients created
 * here, so the harness's rollback neither helps nor hinders. Cleanup is explicit instead:
 * every row committed here is deleted in `afterEach`, and every client is ended in `afterAll`.
 */

type PgClient = ReturnType<typeof postgres>;

/** Every row this file commits carries this prefix, so cleanup can be exact. */
const KEY_PREFIX = 'sched-concurrency:';
const CLAIM_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 3;

/** Poll budget for "is the loser blocked yet?". 400 × 25ms = 10s, inside the 30s timeout. */
const BLOCK_POLL_INTERVAL_MS = 25;
const BLOCK_POLL_ATTEMPTS = 400;

/**
 * Three independent connections, each its own Postgres backend:
 *   · `winner` — takes the claim and (in the forced cases) holds its transaction open;
 *   · `loser`  — the contending claim, which must block and then lose;
 *   · `warden` — seeds, observes `pg_blocking_pids`, asserts committed state, cleans up.
 *
 * `max: 1` on each so a connection is a backend: postgres.js queues statements on the single
 * socket instead of silently opening a second one, which would make "the winner's transaction
 * is open" untrue.
 */
let winnerClient: PgClient;
let loserClient: PgClient;
let wardenClient: PgClient;
let winnerDb: Database;
let loserDb: Database;
let wardenDb: Database;
let winnerPid: number;
let loserPid: number;

/** Held transactions still open, so a failed assertion cannot strand a row lock. */
const openHolds: Array<() => Promise<void>> = [];

/**
 * Contending statements that were ISSUED BUT NOT YET AWAITED, so cleanup can wait for them.
 *
 * ⚠ NOT BOOKKEEPING — IT CLOSES A REAL ORPHAN PATH. The forced cases deliberately leave the
 * loser's statement in flight while they assert. If an assertion throws in that gap, `afterEach`
 * commits the winner (waking the loser) and would otherwise issue its `DELETE` immediately; the
 * woken loser and the `DELETE` then race, and in the `schedule` case a loser that wakes AFTER
 * the delete finds no conflicting live tuple and INSERTS a fresh committed row that nothing ever
 * cleans up. Draining here — after the holds, before the delete — makes that unreachable.
 *
 * Registering also attaches a handler, so a rejected contender cannot surface as a run-level
 * unhandled rejection (vitest fails the run on those) after this file has moved on.
 */
const inFlight: Array<Promise<unknown>> = [];

/** Register an issued-but-not-awaited statement for the `afterEach` drain, and pass it through. */
function contend<T>(statement: Promise<T>): Promise<T> {
  inFlight.push(statement.catch(() => undefined));
  return statement;
}

function claimArgs(id: string): { id: string; claimTtlMinutes: number; maxAttempts: number } {
  return { id, claimTtlMinutes: CLAIM_TTL_MINUTES, maxAttempts: MAX_ATTEMPTS };
}

function key(): string {
  return `${KEY_PREFIX}${randomUUID()}`;
}

async function backendPid(client: PgClient): Promise<number> {
  const rows = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const [row] = rows;
  if (row === undefined) {
    throw new Error('pg_backend_pid() returned no row');
  }
  return row.pid;
}

/**
 * Block until Postgres reports `waiterPid` as waiting on a lock HELD BY `holderPid`.
 *
 * ⚠ THIS CALL *IS* THE DETERMINISM — THERE IS NOTHING TO `expect()` AFTERWARDS. It is a
 * positive observation rather than a delay: the loop's exit condition is the database's own
 * answer to "who is blocking whom", so the test proceeds exactly when the contention it is
 * about to resolve genuinely exists. The interval is only how often the question is asked; no
 * assertion depends on it. Exhausting the budget THROWS rather than falling through, so a race
 * that failed to materialise fails the test loudly instead of quietly degrading into the
 * sequential case. Deliberately returns nothing: a caller asserting on the blocker list would
 * be restating the exit condition, an assertion that cannot fail.
 */
async function waitUntilBlockedBy(waiterPid: number, holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < BLOCK_POLL_ATTEMPTS; attempt += 1) {
    const rows = await wardenClient<{ blockers: number[] }[]>`
      select coalesce(pg_blocking_pids(${waiterPid}::int), '{}'::int[]) as blockers
    `;
    const [row] = rows;
    if (row !== undefined && row.blockers.includes(holderPid)) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, BLOCK_POLL_INTERVAL_MS);
    });
  }
  throw new Error(
    `backend ${waiterPid} never blocked on backend ${holderPid} within ` +
      `${BLOCK_POLL_ATTEMPTS * BLOCK_POLL_INTERVAL_MS}ms — the contention this test needs did not happen`
  );
}

interface HeldTransaction<T> {
  /** What the repository call inside the still-open transaction returned. */
  result: T;
  /** COMMIT it, and wait for the commit to land. Safe to call more than once. */
  commit: () => Promise<void>;
}

/**
 * Run ONE repository call inside a transaction on `target` and leave that transaction OPEN,
 * holding whatever locks the call took, until `commit()` is called.
 *
 * This is the mechanism that makes the interleaving deliberate: with the winner's transaction
 * open, the loser's statement cannot do anything BUT block, so the race is forced to run
 * through the blocking path rather than being decided by whichever packet arrived first.
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

/**
 * Seed one COMMITTED pending row, visible to every connection.
 *
 * `scheduled_for` is deliberately in the FUTURE. `claim` does not read it at all — dueness is
 * `listDue`'s question, not the claim's — so it changes nothing here, while keeping an escaped
 * row out of the PENDING half of another suite's `listDue(now)`.
 *
 * ⚠ IT DOES NOT IMMUNISE THE `claimed` HALF, AND DO NOT WRITE A COMMENT THAT SAYS IT DOES.
 * `listDue`'s second branch is `status = 'claimed' AND claimed_at < now() - ttl` and ignores
 * `scheduled_for` entirely, so a row left `claimed` by the forced cases WOULD be returned once
 * five minutes of DB clock pass, however far in the future its `scheduled_for` is. What actually
 * keeps the sibling suite safe is that its only order/length-sensitive assertion is a
 * `listDue(now, limit: 2)` — and `ORDER BY scheduled_for ASC` puts a `now + 1h` row last, where
 * a `LIMIT 2` cannot reach it. Every other `listDue` assertion there is containment-based. A
 * future unscoped length assertion in that suite would break that argument; scope it, or clean
 * up here harder.
 */
async function seedCommittedPending(dedupeKey: string): Promise<string> {
  const [row] = await wardenDb
    .insert(schema.scheduledNotifications)
    .values({
      dedupeKey,
      event: 'meeting.participant_absent',
      payload: { meetingId: randomUUID() },
      scheduledFor: new Date(Date.now() + 60 * 60_000),
    })
    .returning({ id: schema.scheduledNotifications.id });
  if (row === undefined) {
    throw new Error('seed insert returned no row');
  }
  return row.id;
}

/** What every OTHER connection can see for this row — i.e. what actually got committed. */
async function committedState(id: string): Promise<{ status: string; attempts: number }> {
  const [row] = await wardenDb
    .select({
      status: schema.scheduledNotifications.status,
      attempts: schema.scheduledNotifications.attempts,
    })
    .from(schema.scheduledNotifications)
    .where(eq(schema.scheduledNotifications.id, id));
  if (row === undefined) {
    throw new Error(`row ${id} not found on the committed view`);
  }
  return row;
}

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
    );
  }
  winnerClient = postgres(url, { max: 1 });
  loserClient = postgres(url, { max: 1 });
  wardenClient = postgres(url, { max: 1 });
  winnerDb = drizzle(winnerClient, { schema });
  loserDb = drizzle(loserClient, { schema });
  wardenDb = drizzle(wardenClient, { schema });

  // Also warms both sockets, so a `Promise.all` race is not measuring connection setup.
  winnerPid = await backendPid(winnerClient);
  loserPid = await backendPid(loserClient);

  // ⚠ THE PREMISE OF THE WHOLE FILE, ASSERTED RATHER THAN ASSUMED. If a refactor ever collapsed
  // these onto one backend, `pg_blocking_pids` — which never reports a backend as blocking
  // ITSELF — would simply never name the holder, and every forced case would burn its 10s poll
  // budget and fail with "never blocked", pointing at the race instead of at the real cause.
  expect(new Set([winnerPid, loserPid]).size).toBe(2);
});

afterEach(async () => {
  // ⚠ ORDER IS LOAD-BEARING, ALL THREE STEPS.
  // 1. Release any transaction a failed assertion left open — otherwise the cleanup statement
  //    would itself block on the stranded row lock and burn the 60s hook timeout.
  for (const commit of openHolds.splice(0)) {
    await commit().catch(() => undefined);
  }
  // 2. Let any issued-but-unawaited contender finish now that its blocker is gone, so it cannot
  //    land a row AFTER the delete below (see `inFlight`).
  await Promise.allSettled(inFlight.splice(0));
  // 3. Only now remove what this file committed.
  await wardenDb
    .delete(schema.scheduledNotifications)
    .where(like(schema.scheduledNotifications.dedupeKey, `${KEY_PREFIX}%`));
});

afterAll(async () => {
  // Belt and braces behind `afterEach`: if that delete ever failed or timed out, its rows would
  // otherwise outlive this file for the container's lifetime. Failure here must still not skip
  // the `end()` calls, or the run leaks connections.
  await wardenDb
    .delete(schema.scheduledNotifications)
    .where(like(schema.scheduledNotifications.dedupeKey, `${KEY_PREFIX}%`))
    .catch(() => undefined);
  // `end()` without a timeout waits indefinitely on an in-flight query; bound it so a stuck
  // statement becomes a fast close rather than a 60s hook timeout.
  await Promise.all([
    winnerClient?.end({ timeout: 5 }),
    loserClient?.end({ timeout: 5 }),
    wardenClient?.end({ timeout: 5 }),
  ]);
});

describe('scheduledNotificationsRepository.claim — real concurrency', () => {
  /**
   * The UNFORCED race: both statements are in flight before either reply is read, on two
   * backends, against one committed row. Which one reaches the tuple first is up to Postgres
   * — and that is the point, because the assertion holds for every interleaving.
   *
   * ⚠ READ THE NAME LITERALLY: DISPATCHED TOGETHER IS NOT THE SAME AS CONTENDED. Sampling
   * `pg_stat_activity` across 60 local runs of this exact pattern showed a lock wait in only
   * ~14 of them; the rest of the time the first claim's autocommitted `UPDATE` had already
   * landed before the second statement reached the tuple, which degrades this into the
   * cross-connection form of the sequential suite's case. The assertion holds either way, so
   * this never flakes — it just proves less than "simultaneous" would suggest, with nothing in
   * the output to say which happened. That is precisely why the NEXT case exists and why it,
   * not this one, is the send-once proof. Kept for its own narrow value: the only cross-
   * connection smoke test that both backends can transact a COMMITTED row at all.
   */
  it('two claims DISPATCHED TOGETHER on two connections → exactly ONE winner, attempts = 1 (interleaving NOT forced — see the next case)', async () => {
    const id = await seedCommittedPending(key());

    const [a, b] = await Promise.all([
      scheduledNotificationsRepository.claim(claimArgs(id), winnerDb),
      scheduledNotificationsRepository.claim(claimArgs(id), loserDb),
    ]);

    const winners = [a, b].filter((claimed) => claimed !== undefined);
    expect(winners).toHaveLength(1);
    // The one row Postgres let through is the claimed one, and the attempt was consumed once.
    expect(winners[0]?.status).toBe('claimed');
    expect(await committedState(id)).toEqual({ status: 'claimed', attempts: 1 });
  });

  /**
   * ⚠ THE PATH THE SEQUENTIAL TEST CANNOT REACH — BLOCKING, THEN THE EvalPlanQual RECHECK.
   *
   * The loser's `UPDATE` is issued while the winner's claim is committed to nothing yet, so
   * the loser's snapshot still shows `status='pending'`: its `WHERE` PASSES and it commits to
   * updating the row, then blocks on the winner's tuple lock. `pg_blocking_pids` is asserted
   * here rather than assumed — the test does not proceed until Postgres itself names the
   * winner's backend as the blocker, so "the loser was actually blocked" is a measured fact.
   *
   * Only then does the winner commit. What the loser does next is the entire guarantee: under
   * READ COMMITTED it follows the update chain to the winner's new row version and
   * re-evaluates its `WHERE` against THAT version. `status='claimed'` with a `claimed_at`
   * inside the TTL fails the predicate, the row is excluded, and `RETURNING` yields nothing.
   * If the predicate had been written so that a claimed-but-fresh row still satisfied it, this
   * is where a second send would be born — and this is the only place a test can see it.
   */
  it('a claim that BLOCKS on the winner’s row lock loses the EvalPlanQual recheck', async () => {
    const id = await seedCommittedPending(key());

    const held = await holdOpen(winnerDb, (tx) =>
      scheduledNotificationsRepository.claim(claimArgs(id), tx)
    );
    expect(held.result).toBeDefined();
    expect(held.result?.status).toBe('claimed');

    // Issued, NOT awaited — it must be in flight and blocked before the winner commits.
    const contending = contend(scheduledNotificationsRepository.claim(claimArgs(id), loserDb));

    // THE GATE IS THE CALL, NOT AN `expect`: `waitUntilBlockedBy` only returns once Postgres
    // has named `winnerPid` as the blocker, and throws otherwise. There is deliberately no
    // assertion on its return value — one could not fail, and writing it would misrepresent
    // where the determinism comes from.
    await waitUntilBlockedBy(loserPid, winnerPid);

    await held.commit();

    expect(await contending).toBeUndefined();
    // The loser's `UPDATE` reached the tuple and was thrown out by the recheck: exactly one
    // attempt was ever consumed.
    expect(await committedState(id)).toEqual({ status: 'claimed', attempts: 1 });
  });

  /**
   * The same forced interleaving with the winner ROLLED BACK instead of committed is NOT
   * tested here on purpose: a rolled-back claim leaves the row `pending`, so the loser's
   * recheck passes and it claims — correct, and already covered by the ordinary
   * "claims a pending row" case. What matters for send-once is the committed side, above.
   */
});

/**
 * ⚠ THE OTHER CONCURRENCY CLAIM THIS REPOSITORY MAKES IN PROSE, NOW PINNED BY A TEST.
 *
 * `cancel`'s docstring asserts: "when a cancel and a claim contend for the same row, Postgres
 * serialises the two UPDATEs and exactly one wins — if cancel wins the row is never selected
 * again; if the claim wins the recheck reads live state and skips. No double-send and no
 * false-send on either ordering." That is the SAME EvalPlanQual mechanism as the claim race
 * above, and until these two cases it was an unproven assertion of exactly the kind this file
 * exists to retire. The nearest sequential case (`does NOT cancel a CLAIMED row`) tests the
 * easy, already-visible ordering — the one that never blocks.
 *
 * Both orderings are covered because they fail differently and both failures are user-visible:
 * a cancel that wins against an in-flight send produces "we cancelled it and it sent anyway";
 * a claim that wins against a committed cancel produces "we sent something already voided".
 */
describe('scheduledNotificationsRepository.cancel × claim — real concurrency', () => {
  /**
   * CLAIM FIRST. The cancel's `WHERE` still sees `pending` in its own snapshot, so it passes,
   * commits to updating the row, and blocks. On the winner's commit it re-evaluates against the
   * `claimed` version, fails `status = 'pending'`, and cancels NOTHING — returning 0, which is a
   * normal outcome, not an error. The send in flight is never voided underneath itself; the
   * fire-time recheck remains the authority (ADR Decision 5).
   */
  it('a cancel that BLOCKS on an in-flight claim loses — the claimed row is NOT voided mid-send', async () => {
    const dedupeKey = key();
    const id = await seedCommittedPending(dedupeKey);

    const held = await holdOpen(winnerDb, (tx) =>
      scheduledNotificationsRepository.claim(claimArgs(id), tx)
    );
    expect(held.result?.status).toBe('claimed');

    const contending = contend(scheduledNotificationsRepository.cancel(dedupeKey, loserDb));
    await waitUntilBlockedBy(loserPid, winnerPid);
    await held.commit();

    // Zero rows cancelled — and crucially the row is still `claimed`, not `cancelled`.
    expect(await contending).toBe(0);
    expect(await committedState(id)).toEqual({ status: 'claimed', attempts: 1 });
  });

  /**
   * CANCEL FIRST — the ordering that matters most, because the failure mode is sending a
   * notification the caller already voided. The claim's `WHERE` sees `pending`, passes, blocks;
   * on the cancel's commit it rechecks against the `cancelled` version, which satisfies neither
   * `status = 'pending'` nor the stale-`claimed` branch, so it returns `undefined` and the
   * dispatch tick publishes NOTHING. `attempts` staying 0 is the second signal: the row was
   * never even nominally taken.
   */
  it('a claim that BLOCKS on an in-flight cancel loses — a cancelled promise is never sent', async () => {
    const dedupeKey = key();
    const id = await seedCommittedPending(dedupeKey);

    const held = await holdOpen(winnerDb, (tx) =>
      scheduledNotificationsRepository.cancel(dedupeKey, tx)
    );
    expect(held.result).toBe(1);

    const contending = contend(scheduledNotificationsRepository.claim(claimArgs(id), loserDb));
    await waitUntilBlockedBy(loserPid, winnerPid);
    await held.commit();

    expect(await contending).toBeUndefined();
    expect(await committedState(id)).toEqual({ status: 'cancelled', attempts: 0 });
  });
});

describe('scheduledNotificationsRepository.schedule — real concurrency', () => {
  /**
   * FIRST-WINS UNDER A GENUINE INSERT RACE, forced the same way. The winner's `INSERT` has
   * completed inside an open transaction, so its index tuple exists but is uncommitted; the
   * loser's `INSERT … ON CONFLICT` finds it, cannot tell yet whether it will exist, and waits
   * on the winner's transaction id — again asserted through `pg_blocking_pids`, not assumed.
   *
   * When the winner commits, the loser's `ON CONFLICT … DO UPDATE` resolves against the
   * now-committed row: it folds, returns THAT row, and `schedule` reports `already_pending`
   * because the returned id is not the id this call minted. That client-minted-id check is
   * what makes the outcome decidable at all under concurrency (see the repository's docstring
   * — comparing timestamps would be wrong, not merely fragile).
   *
   * This is the partial unique index doing its real job: not "reject a duplicate" but "make
   * two racing schedulers agree on ONE promise without either of them erroring".
   */
  it('two simultaneous first_wins schedules of one key → ONE row; the loser folds', async () => {
    const dedupeKey = key();
    const scheduledFor = new Date(Date.now() + 60 * 60_000);

    const held = await holdOpen(winnerDb, (tx) =>
      scheduledNotificationsRepository.schedule(
        {
          dedupeKey,
          event: 'meeting.participant_absent',
          payload: { attempt: 'winner' },
          scheduledFor,
        },
        tx
      )
    );
    expect(held.result.outcome).toBe('scheduled');

    const contending = contend(
      scheduledNotificationsRepository.schedule(
        {
          dedupeKey,
          event: 'some.other_event',
          payload: { attempt: 'loser' },
          scheduledFor: new Date(Date.now() + 120 * 60_000),
        },
        loserDb
      )
    );

    // Gate, not assertion — see the claim case above.
    await waitUntilBlockedBy(loserPid, winnerPid);

    await held.commit();

    const folded = await contending;
    expect(folded.outcome).toBe('already_pending');
    expect(folded.row.id).toBe(held.result.row.id);
    // The winner's promise stands, untouched — the loser superseded nothing.
    expect(folded.row.event).toBe('meeting.participant_absent');
    expect(folded.row.payload).toEqual({ attempt: 'winner' });

    const live = await wardenDb
      .select({ id: schema.scheduledNotifications.id })
      .from(schema.scheduledNotifications)
      .where(eq(schema.scheduledNotifications.dedupeKey, dedupeKey));
    expect(live).toHaveLength(1);
  });
});
