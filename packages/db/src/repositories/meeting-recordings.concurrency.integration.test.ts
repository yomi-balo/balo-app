import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../schema';
import { _setDb, type Database } from '../client';
import { meetingRecordingsRepository } from './meeting-recordings';

/**
 * ⚠⚠ THE ACCEPTANCE CRITERION: "A CONCURRENT DUPLICATE `recording-ensure` LOSES THE UNIQUE
 * INDEX AND DOES NOTHING" — PROVEN ON TWO GENUINELY SIMULTANEOUS POSTGRES BACKENDS.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `meeting-recordings.integration.test.ts`. That suite
 * writes through the harness's single `max: 1` connection inside one open transaction
 * (`test/setup-integration.ts`), so two `insertCapturing` calls there can only ever run
 * SEQUENTIALLY — the second sees the first's committed-to-the-transaction row and conflicts
 * on a lookup, not on a race. It proves the OUTCOME is right when the calls are ordered. It
 * cannot touch the question this file answers, which is what happens when they are NOT
 * (memory `reference_db_integration_harness_no_concurrency`).
 *
 * WHAT WOULD GO WRONG WITHOUT THE INDEX. `recording-ensure` gates on
 * `findCapturingForMeeting` before inserting. That read-then-write is a classic
 * check-then-act: under READ COMMITTED two ensures for the same meeting (an `in_progress`
 * transition and a `participant.joined` re-arm arriving together, or a BullMQ retry
 * overlapping its original) can BOTH read "no capturing segment" before either writes. With
 * no unique index, both insert, both call `POST /rooms/:name/recordings/start`, and the
 * meeting gets TWO simultaneous Daily cloud recordings — double vendor cost, two segments
 * covering the same wall-clock, and a `findCapturingForMeeting` that now returns an arbitrary
 * one of them forever after.
 *
 * ⚠ THE FIX IS `meeting_recording_capturing_idx`, AND THIS FILE IS WHAT PINS IT. It is
 * UNIQUE on `(meeting_id) WHERE capture_ended_at IS NULL AND deleted_at IS NULL`, so the
 * second INSERT BLOCKS on the first's uncommitted index entry, and — when the first commits —
 * fails `23505`. `insertCapturing` catches exactly that and returns `undefined`, which the
 * job treats as a SUCCESSFUL no-op ("somebody else is already capturing") rather than an
 * error to retry.
 *
 * ⚠⚠ DROP THE INDEX AND THIS FILE GOES RED, not green-but-weaker: the forced case asserts
 * exactly one row survives and exactly one caller got a row back. Two rows ⇒ failure.
 *
 * ⚠ WHY THE PREDICATE IS ON `capture_ended_at` AND NOT `status = 'recording'`. The house rule
 * (`meeting-files.ts`, `transcripts.ts`, `action-items.ts`) is that an index predicate names
 * COLUMNS ONLY — a label added later by `ALTER TYPE … ADD VALUE` cannot be used in the same
 * migration transaction. So the slot rides a TIMESTAMP. That is not a workaround: it is what
 * makes the guarantee expressible as a real database constraint at all.
 *
 * DETERMINISM. Nothing here waits a fixed interval and hopes. The forced case holds the
 * winner's transaction OPEN and polls `pg_blocking_pids()` until Postgres itself reports the
 * loser as blocked BY the winner's backend — an observed fact, not a timing assumption — and
 * only then commits the winner.
 *
 * HARNESS RELATIONSHIP. `setupFiles` still runs for this file — its `beforeEach` opens a
 * transaction on the shared client and points the module-level `db` at it. NOTHING BELOW USES
 * THAT `db`, or any factory that does: rows written inside that transaction are invisible to
 * any other connection, and two simultaneous connections cannot be expressed on a `max: 1`
 * pool. Every row here is written, read and deleted through the clients created below, so the
 * harness's rollback neither helps nor hinders. Cleanup is explicit instead — and the seeding
 * helper inserts RAW rather than reusing `packages/db/src/test/factories`, which are
 * hard-wired to the harness `db`.
 *
 * ⚠⚠ `insertCapturing` IS DELIBERATELY STANDALONE-ONLY — IT TAKES NO `DbExecutor` — AND THAT
 * DICTATES THE SHAPE OF THIS FILE. It catches a raw `23505`, which inside an ambient
 * transaction would abort that transaction (`25P02`), so its signature refuses an executor
 * rather than merely documenting the hazard. Two consequences follow, and both are
 * deliberate:
 *
 *   1. IT WRITES THROUGH THE MODULE-LEVEL `db`, which the harness has repointed at the
 *      per-test transaction. Passing `loserDb` is not an option the way
 *      `reviewsRepository.upsert(input, loserDb)` is in the sibling concurrency suite. So
 *      `beforeEach` below repoints the module `db` at `loserDb` via `_setDb` — the same
 *      documented `@internal` seam `test/setup-integration.ts` itself uses — for the duration
 *      of each test. The harness `afterEach` (registered FIRST, therefore run LAST) restores
 *      it, so nothing leaks into another file.
 *   2. THE WINNER IS HELD OPEN ON A RAW INSERT of the same row shape, not on the repository
 *      call — a held-open `insertCapturing` would be exactly the ambient-transaction misuse
 *      its contract forbids. That is the correct way round anyway: the LOSER is the code path
 *      under test, and it runs exactly as production runs it, on its own implicit transaction.
 */

type PgClient = ReturnType<typeof postgres>;

/** Every meeting this file commits is tracked by id, so cleanup can be exact. */
const seededMeetingIds: string[] = [];

/** Poll budget for "is the loser blocked yet?". 400 × 25ms = 10s, inside the 30s timeout. */
const BLOCK_POLL_INTERVAL_MS = 25;
const BLOCK_POLL_ATTEMPTS = 400;

/**
 * Three independent connections, each its own Postgres backend:
 *   · `winner` — takes the first capturing insert and holds its transaction open;
 *   · `loser`  — the contending `insertCapturing`, which must block on the unique index;
 *   · `warden` — seeds, observes `pg_blocking_pids`, asserts committed state, cleans up.
 *
 * `max: 1` on each so a connection IS a backend: postgres.js queues statements on the single
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
 * NOT bookkeeping — the forced case deliberately leaves the loser's statement in flight while
 * it asserts, and if an assertion throws in that gap, `afterEach` commits the winner (waking
 * the loser) and would otherwise issue its `DELETE` immediately, racing a woken writer that
 * can still land a row nothing ever cleans up. Registering also attaches a handler, so a
 * rejected contender cannot surface as a run-level unhandled rejection.
 */
const inFlight: Array<Promise<unknown>> = [];

/** Register an issued-but-not-awaited statement for the `afterEach` drain, and pass it through. */
function contend<T>(statement: Promise<T>): Promise<T> {
  inFlight.push(statement.catch(() => undefined));
  return statement;
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
 * that failed to materialise fails loudly instead of quietly degrading into the sequential
 * case — which is precisely how a deleted unique index would otherwise slip through green.
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
  const budgetMs = BLOCK_POLL_ATTEMPTS * BLOCK_POLL_INTERVAL_MS;
  throw new Error(
    `backend ${waiterPid} never blocked on backend ${holderPid} within ${budgetMs}ms — the ` +
      `contention this test needs did not happen. The usual cause is that ` +
      `meeting_recording_capturing_idx is missing or no longer UNIQUE, in which case the ` +
      `second insert never has to wait and BOTH segments land. See this file's header.`
  );
}

interface HeldTransaction<T> {
  /** What the statement inside the still-open transaction returned. */
  result: T;
  /** COMMIT it, and wait for the commit to land. Safe to call more than once. */
  commit: () => Promise<void>;
}

/**
 * Run ONE statement inside a transaction on `target` and leave that transaction OPEN, holding
 * whatever locks it took, until `commit()` is called.
 *
 * This is what makes the interleaving deliberate: with the winner's transaction open, the
 * loser's insert cannot do anything BUT block on the uncommitted unique-index entry, so the
 * race runs through the blocking path rather than being decided by whichever packet arrived
 * first.
 */
async function holdOpen<T>(
  target: Database,
  run: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>
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
 * One COMMITTED meeting, visible to every backend.
 *
 * Deliberately CONTEXT-FREE (no `meeting_contexts` row): the ≥1-context invariant lives on
 * `meetingsRepository.create`, not on the table, and nothing about the capture slot involves
 * a context. Seeding one would drag the whole engagement fixture chain into a test about a
 * single unique index.
 */
async function seedMeeting(): Promise<string> {
  const now = Date.now();
  const [row] = await wardenDb
    .insert(schema.meetings)
    .values({
      scheduledStart: new Date(now + 3_600_000),
      scheduledEnd: new Date(now + 7_200_000),
      status: 'in_progress',
      dailyRoomName: `balo-${randomUUID().replace(/-/g, '')}`,
    })
    .returning({ id: schema.meetings.id });
  if (row === undefined) {
    throw new Error('meeting insert failed');
  }
  seededMeetingIds.push(row.id);
  return row.id;
}

/** Every committed segment for a meeting, on the COMMITTED view — i.e. what really landed. */
async function committedSegments(meetingId: string): Promise<string[]> {
  const rows = await wardenDb
    .select({ id: schema.meetingRecordings.id })
    .from(schema.meetingRecordings)
    .where(eq(schema.meetingRecordings.meetingId, meetingId));
  return rows.map((row) => row.id);
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

  // ⚠ THE PREMISE OF THE WHOLE FILE, ASSERTED RATHER THAN ASSUMED. If a refactor ever
  // collapsed these onto one backend, `pg_blocking_pids` — which never reports a backend as
  // blocking ITSELF — would simply never name the holder, and the forced case would burn its
  // 10s poll budget and fail pointing at the race instead of at the real cause.
  expect(new Set([winnerPid, loserPid]).size).toBe(2);
});

/**
 * ⚠ POINT THE MODULE-LEVEL `db` AT THE LOSER'S BACKEND — see consequence (1) in the header.
 * `insertCapturing` takes no executor by contract, so this is the ONLY way to run the real
 * production code path on a backend that can genuinely contend with the winner's.
 *
 * Registered here, so it runs AFTER `setup-integration.ts`'s own `beforeEach` (which points
 * `db` at the per-test transaction) and wins. The harness's `afterEach` restores the shared
 * client, so no other file ever sees this.
 */
beforeEach(() => {
  _setDb(loserDb);
});

/**
 * Delete everything this file committed.
 *
 * `meeting_recordings.meeting_id` is ON DELETE CASCADE, so deleting the meetings takes the
 * segments with them — one statement, no ordering hazard.
 *
 * ⚠ AND IT MUST NOT THROW. `setup-integration.ts` registers its own `afterEach` (which ROLLS
 * BACK the harness transaction) FIRST, so vitest runs it LAST — a throw here means the harness
 * transaction is never rolled back, its `max: 1` connection stays pinned, and every subsequent
 * `beforeEach` in the run queues behind it until the hook timeout. One wrong delete therefore
 * does not fail one test, it hangs the file.
 */
async function deleteSeededRows(): Promise<void> {
  const meetingIds = seededMeetingIds.splice(0);
  if (meetingIds.length > 0) {
    await wardenDb.delete(schema.meetings).where(inArray(schema.meetings.id, meetingIds));
  }
}

afterEach(async () => {
  // ⚠ ORDER IS LOAD-BEARING, ALL THREE STEPS.
  // 1. Release any transaction a failed assertion left open — otherwise the cleanup statements
  //    would themselves block on the stranded lock and burn the hook timeout.
  for (const commit of openHolds.splice(0)) {
    await commit().catch(() => undefined);
  }
  // 2. Let any issued-but-unawaited contender finish now that its blocker is gone, so it
  //    cannot land a row AFTER the deletes below (see `inFlight`).
  await Promise.allSettled(inFlight.splice(0));
  // 3. Only now remove what this file committed.
  await deleteSeededRows();
});

afterAll(async () => {
  // Belt and braces behind `afterEach`: if that ever failed or timed out, its rows would
  // otherwise outlive this file for the container's lifetime. Failure here must still not skip
  // the `end()` calls, or the run leaks connections.
  await deleteSeededRows().catch(() => undefined);
  // `end()` without a timeout waits indefinitely on an in-flight query; bound it so a stuck
  // statement becomes a fast close rather than a hook timeout.
  await Promise.all([
    winnerClient?.end({ timeout: 5 }),
    loserClient?.end({ timeout: 5 }),
    wardenClient?.end({ timeout: 5 }),
  ]);
});

describe('meetingRecordingsRepository.insertCapturing — the capture slot under real concurrency', () => {
  /**
   * ⚠⚠ THE ONE THAT CARRIES THE PROOF, AND THE ONE THE AC NAMES.
   *
   * T1 inserts a capturing segment for the meeting and is held open, so its entry in
   * `meeting_recording_capturing_idx` exists but is uncommitted. T2 then runs the REAL
   * `insertCapturing` on a different backend and must block on that index entry — asserted
   * through `pg_blocking_pids`, not assumed, which is simultaneously the assertion that the
   * unique index still exists at all.
   *
   * Only then does T1 commit. T2's blocked INSERT is released, finds the now-committed
   * conflicting entry, and raises `23505` — which `insertCapturing` catches and maps to
   * `undefined`.
   *
   * The three candidate outcomes are all distinguishable, which is why the assertions are
   * written this way:
   *   1 row + loser `undefined`  — correct: the duplicate lost and did nothing.
   *   2 rows                     — THE BUG: the unique index is gone, and this meeting is
   *                                about to get two simultaneous Daily cloud recordings.
   *   a thrown 23505             — the catch in `insertCapturing` is gone, and the ensure job
   *                                would fail and retry instead of no-opping.
   */
  it('a concurrent duplicate BLOCKS on the unique index, then loses it and returns undefined', async () => {
    const meetingId = await seedMeeting();

    // T1: a capturing row, held open on its uncommitted unique-index entry. Inserted RAW
    // rather than via `insertCapturing`, which is standalone-only by contract — the LOSER is
    // the code path under test, and it runs exactly as production runs it.
    const held = await holdOpen(winnerDb, (tx) =>
      tx.insert(schema.meetingRecordings).values({ meetingId }).returning({
        id: schema.meetingRecordings.id,
      })
    );
    expect(held.result).toHaveLength(1);

    // Not yet visible to anyone else — the winner has not committed.
    expect(await committedSegments(meetingId)).toHaveLength(0);

    // T2: THE REAL PRODUCTION PATH, on the loser's backend (the module `db` was repointed in
    // `beforeEach`). Issued, NOT awaited — it must be in flight and blocked before the winner
    // commits.
    const contending = contend(meetingRecordingsRepository.insertCapturing({ meetingId }));

    // THE GATE IS THE CALL, NOT AN `expect`. It returns only once Postgres has named
    // `winnerPid` as the blocker, and throws otherwise — including when the unique index has
    // been dropped, which is the regression this whole file exists to catch.
    await waitUntilBlockedBy(loserPid, winnerPid);

    await held.commit();

    // ⚠ THE LOSER RETURNS `undefined`, IT DOES NOT THROW. That is what makes a duplicate
    // ensure a SUCCESSFUL no-op rather than a job failure that BullMQ would retry.
    await expect(contending).resolves.toBeUndefined();

    // Exactly ONE segment committed. Two would mean two Daily recordings in one room.
    const committed = await committedSegments(meetingId);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toBe(held.result[0]?.id);
  });

  /**
   * THE INDEX ITSELF, INDEPENDENT OF THE REPOSITORY — two RAW inserts dispatched together on
   * two real backends.
   *
   * ⚠ WHY THIS IS NOT A DUPLICATE OF THE CASE ABOVE. That one proves `insertCapturing`
   * CATCHES the conflict and answers `undefined`. This one proves the conflict is genuinely
   * RAISED across two independent backends with no application code in the way — i.e. that
   * the guarantee lives in Postgres and not in a `try/catch`. If someone replaced the unique
   * index with an application-level check, the case above would still pass (the catch would
   * simply never fire and the second insert would return a row — caught by its row-count
   * assertion), while THIS case would fail loudly on the missing `23505`.
   *
   * ⚠ READ THE NAME LITERALLY: DISPATCHED TOGETHER IS NOT THE SAME AS CONTENDED. Whether the
   * second insert actually waits on the first is up to Postgres. The assertion holds for every
   * interleaving, so this never flakes; the FORCED case above is the one that proves blocking.
   */
  it('two RAW inserts dispatched together on two backends: one lands, the other raises 23505', async () => {
    const meetingId = await seedMeeting();

    const results = await Promise.allSettled([
      winnerDb.insert(schema.meetingRecordings).values({ meetingId }),
      loserDb.insert(schema.meetingRecordings).values({ meetingId }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The unique-violation SQLSTATE, raised by the database — not by anything we wrote.
    expect(rejected[0]?.reason).toMatchObject({ code: '23505' });

    expect(await committedSegments(meetingId)).toHaveLength(1);
  });

  /**
   * THE ANTI-VACUITY CASE. Every assertion above is about a duplicate LOSING, so a
   * `meeting_recording_capturing_idx` that rejected EVERYTHING — or an `insertCapturing` that
   * always returned `undefined` — would pass them all. This one proves the slot really does
   * re-open, on real backends, once capture ends.
   *
   * It is also the 1:n rejoin story (D2) at the concurrency layer: Daily auto-stops on
   * `minIdleTimeOut`, `ready-to-download` stamps `capture_ended_at`, and the rejoin's ensure
   * must then be able to start a genuinely new segment.
   */
  it('the slot RE-OPENS once capture_ended_at is stamped — a duplicate is not rejected forever', async () => {
    const meetingId = await seedMeeting();

    const first = await meetingRecordingsRepository.insertCapturing({ meetingId });
    if (first === undefined) throw new Error('expected the first segment to insert');

    // While the slot is held, a second ensure loses.
    expect(await meetingRecordingsRepository.insertCapturing({ meetingId })).toBeUndefined();

    // Release it exactly as `markSourceReady` does — the timestamp is what the index reads.
    await wardenDb
      .update(schema.meetingRecordings)
      .set({ status: 'source_ready', captureEndedAt: new Date() })
      .where(eq(schema.meetingRecordings.id, first.id));

    // …and the rejoin now gets a real, distinct segment.
    const second = await meetingRecordingsRepository.insertCapturing({ meetingId });
    expect(second).toBeDefined();
    expect(second?.id).not.toBe(first.id);
    expect(await committedSegments(meetingId)).toHaveLength(2);
  });
});
