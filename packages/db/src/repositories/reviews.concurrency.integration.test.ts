import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../schema';
import type { Database } from '../client';
import type { DbExecutor } from './_shared/db-executor';
import { reviewsRepository, type UpsertReviewInput } from './reviews';

/**
 * ⚠⚠ THE LOST-UPDATE PROOF FOR `recomputeRatingAggregate` — TWO GENUINELY SIMULTANEOUS
 * POSTGRES BACKENDS.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `reviews.integration.test.ts`. That suite writes
 * every review through the harness's single `max: 1` connection inside one open
 * transaction (`test/setup-integration.ts`), so it can only ever run recomputes
 * SEQUENTIALLY. It proves the AGGREGATE IS RIGHT. It cannot touch the question this file
 * answers, which is whether it stays right when two review writes for the SAME EXPERT
 * overlap.
 *
 * WHAT WOULD GO WRONG WITHOUT THE LOCK — and BAL-422's ticket originally asserted this
 * could not happen ("a full recompute reads the current row set, so two racing
 * transactions each converge on the correct value"). That claim is FALSE under READ
 * COMMITTED:
 *
 *   1. T1 inserts a review on engagement A, then runs the aggregate. Its snapshot sees
 *      its own uncommitted row plus committed rows — NOT T2's.
 *   2. T2 inserts a review on engagement B, then runs the aggregate. Same: it cannot see
 *      T1's row.
 *   3. Both UPDATE `expert_profiles`. T2 blocks on T1's row lock; T1 commits; T2 then
 *      writes THE AGGREGATE IT COMPUTED IN STEP 2 — which never included T1's review.
 *
 * The stored average silently omits a review and nothing detects it. Note the review
 * INSERT is no help: the partial unique arbiter only serialises writes to the SAME
 * (engagement, reviewer, expert) triple, so two DIFFERENT engagements — the common case,
 * and the fixture below — never contend there. And unlike the `scheduled_notifications`
 * claim race, there is NO predicate for EvalPlanQual to re-check: the `SET` values were
 * computed by an earlier statement and are not re-evaluated when the lock is granted.
 *
 * ⚠ THE FIX IS AN ORDERING, AND THIS TEST IS WHAT PINS IT. `recomputeRatingAggregate`
 * takes `SELECT … FOR NO KEY UPDATE` on the `expert_profiles` row BEFORE reading the
 * reviews, inside its own transaction. T2 then cannot reach the aggregate until T1 has
 * committed and released; under READ COMMITTED each STATEMENT takes a fresh snapshot, so
 * T2's aggregate — issued after the lock is granted — sees T1's committed review.
 *
 * ⚠ WHY `FOR NO KEY UPDATE` AND NOT `FOR UPDATE`. `FOR UPDATE` conflicts with `FOR KEY
 * SHARE`, which Postgres's RI trigger takes on the `expert_profiles` row for EVERY insert
 * into a table that FKs it — `engagements`, `credit_sessions`, `consultations`,
 * `availability_rules`, … — so it would make a review write block a live consultation
 * start. `FOR NO KEY UPDATE` conflicts with ITSELF, which is the entire requirement (the
 * only writer being serialised is another copy of the same function), and leaves `FOR KEY
 * SHARE` alone. That choice is also why the mechanism case below is written the way it is.
 *
 * ⚠⚠ REMOVE THE `.for('no key update')` AND THIS FILE GOES RED — BOTH WAYS, AND THE TWO
 * WAYS ARE DIFFERENT ON PURPOSE. Verified by actually deleting the line and running it:
 *
 *   · `a second review write that BLOCKS …` fails on the VALUE: it stores `1.0 / 1`
 *     instead of `3.0 / 2` — the lost update itself, caught in the act. (It does NOT fail
 *     with "never blocked": the recompute's own `UPDATE` takes a row lock too, so the loser
 *     still waits — just AFTER it has already computed its stale aggregate, which is the
 *     entire bug.)
 *   · `the recompute takes a row lock BEFORE it reads …` exhausts its poll budget and
 *     fails naming the cause. That case exists precisely to make the MECHANISM, not only
 *     the outcome, non-optional; see its own docblock for how it distinguishes the two
 *     statements now that lock STRENGTH alone no longer can.
 *
 * Both are needed. The value test alone would still pass if someone "fixed" the ordering
 * with a coarser lock that happened to work; the mechanism test alone would pass on a
 * recompute that locked correctly and then computed the wrong number.
 *
 * ⚠ DEPENDS ON READ COMMITTED, the Postgres default and the testcontainer's setting.
 *
 * DETERMINISM. Nothing here waits a fixed interval and hopes. The forced case holds the
 * winner's transaction OPEN and polls `pg_blocking_pids()` until Postgres itself reports
 * the loser as blocked BY the winner's backend — an observed fact, not a timing
 * assumption — and only then commits the winner.
 *
 * HARNESS RELATIONSHIP. `setupFiles` still runs for this file — its `beforeEach` opens a
 * transaction on the shared client and points the module-level `db` at it. NOTHING BELOW
 * USES THAT `db`, or any factory that does: rows written inside that transaction are
 * invisible to any other connection, and two simultaneous connections cannot be expressed
 * on a `max: 1` pool (`reference_db_integration_harness_no_concurrency`). Every row here
 * is written, read and deleted through the clients created below, so the harness's
 * rollback neither helps nor hinders. Cleanup is explicit instead.
 *
 * The seeding helpers therefore insert RAW rather than reusing `packages/db/src/test/
 * factories` — the factories are hard-wired to the harness `db`. They are deliberately
 * minimal (no `project_engagements` child): the composite FK on `reviews` targets the
 * SUPERTYPE's `engagement_id_expert_uq`, and nothing requires a child row to exist.
 */

type PgClient = ReturnType<typeof postgres>;

/** Every user this file commits carries this prefix, so cleanup can be exact. */
const EMAIL_PREFIX = 'reviews-concurrency-';

/** Poll budget for "is the loser blocked yet?". 400 × 25ms = 10s, inside the 30s timeout. */
const BLOCK_POLL_INTERVAL_MS = 25;
const BLOCK_POLL_ATTEMPTS = 400;

/**
 * Three independent connections, each its own Postgres backend:
 *   · `winner` — takes the first review write and holds its transaction open;
 *   · `loser`  — the contending review write, which must block on the expert row lock;
 *   · `warden` — seeds, observes `pg_blocking_pids`, asserts committed state, cleans up.
 *
 * `max: 1` on each so a connection IS a backend: postgres.js queues statements on the
 * single socket instead of silently opening a second one, which would make "the winner's
 * transaction is open" untrue.
 */
let winnerClient: PgClient;
let loserClient: PgClient;
let wardenClient: PgClient;
let winnerDb: Database;
let loserDb: Database;
let wardenDb: Database;
let winnerPid: number;
let loserPid: number;

/** Salesforce vertical — seeded COMMITTED by `global-setup`, so every backend sees it. */
let verticalId: string;

/** Ids this file committed, newest first, for the `afterEach` teardown. */
const seededExpertProfileIds: string[] = [];
const seededCompanyIds: string[] = [];
const seededUserIds: string[] = [];

/** Held transactions still open, so a failed assertion cannot strand a row lock. */
const openHolds: Array<() => Promise<void>> = [];

/**
 * Contending statements that were ISSUED BUT NOT YET AWAITED, so cleanup can wait for
 * them. NOT bookkeeping — it closes a real orphan path: the forced case deliberately
 * leaves the loser's statement in flight while it asserts, and if an assertion throws in
 * that gap, `afterEach` commits the winner (waking the loser) and would otherwise issue
 * its `DELETE` immediately, racing a woken writer that can still commit rows nothing ever
 * cleans up. Registering also attaches a handler, so a rejected contender cannot surface
 * as a run-level unhandled rejection after this file has moved on.
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
 * The SQL text `recomputeRatingAggregate`'s explicit lock statement must present. Drizzle
 * emits `select "id" from "expert_profiles" where … for no key update`, and postgres.js
 * sends that text to the server verbatim (parameters ride separately), so
 * `pg_stat_activity.query` reports it exactly. The recompute's OTHER statement — the
 * `update … set … from …` — cannot match it, which is the whole discriminator.
 */
const LOCKING_READ_PATTERN = /^\s*select\b[\s\S]*\bfor\s+no\s+key\s+update\b\s*$/i;

/**
 * Block until Postgres reports `waiterPid` as waiting on a lock HELD BY `holderPid` —
 * optionally also requiring that the statement it is blocked ON matches `onStatement`.
 *
 * ⚠ THIS CALL *IS* THE DETERMINISM — THERE IS NOTHING TO `expect()` AFTERWARDS. It is a
 * positive observation rather than a delay: the loop's exit condition is the database's
 * own answer to "who is blocking whom" (and, with `onStatement`, "on which statement"), so
 * the test proceeds exactly when the contention it is about to resolve genuinely exists.
 * The interval is only how often the question is asked; no assertion depends on it.
 * Exhausting the budget THROWS rather than falling through, so a race that failed to
 * materialise fails the test loudly instead of quietly degrading into the sequential case.
 * Deliberately returns nothing: a caller asserting on the blocker list would be restating
 * the exit condition.
 *
 * ⚠ WHY `onStatement` EXISTS, AND WHY IT IS NOT A WEAKER CHECK THAN THE OLD LOCK-STRENGTH
 * PROBE. The recompute issues TWO statements that can block on the expert row: the explicit
 * locking `SELECT`, and its own `UPDATE`. When the explicit lock was `FOR UPDATE` the two
 * could be told apart by STRENGTH — a held `FOR KEY SHARE` conflicted with the first and
 * not the second. The lock is now `FOR NO KEY UPDATE`, which is exactly what a non-key
 * `UPDATE` takes, so NO held lock strength can distinguish them any more: any probe that
 * blocks the `SELECT` blocks the `UPDATE` too. The distinguishing evidence moves from
 * WHICH LOCK to WHICH STATEMENT, read out of `pg_stat_activity.query` — a backend blocked
 * on a lock has `state = 'active'`, and `query` is then the statement it is executing. The
 * observation is just as positive, and just as un-timed: the waiter stays parked on that
 * one statement until the holder commits, so a poll cannot miss it.
 *
 * `pg_stat_activity` is queried on `wardenClient`, a THIRD backend, so observing costs the
 * waiter and the holder nothing.
 */
async function waitUntilBlockedBy(
  waiterPid: number,
  holderPid: number,
  onStatement?: { pattern: RegExp; describe: string }
): Promise<void> {
  let lastSeenQuery = '(never observed)';
  for (let attempt = 0; attempt < BLOCK_POLL_ATTEMPTS; attempt += 1) {
    const rows = await wardenClient<{ blockers: number[]; query: string }[]>`
      select coalesce(pg_blocking_pids(${waiterPid}::int), '{}'::int[]) as blockers,
             coalesce((select query from pg_stat_activity where pid = ${waiterPid}::int), '') as query
    `;
    const [row] = rows;
    if (row !== undefined && row.blockers.includes(holderPid)) {
      if (onStatement === undefined) {
        return;
      }
      lastSeenQuery = row.query;
      if (onStatement.pattern.test(row.query)) {
        return;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, BLOCK_POLL_INTERVAL_MS);
    });
  }
  const budgetMs = BLOCK_POLL_ATTEMPTS * BLOCK_POLL_INTERVAL_MS;
  if (onStatement !== undefined) {
    throw new Error(
      `backend ${waiterPid} was never observed blocked on backend ${holderPid} while running ` +
        `${onStatement.describe}, within ${budgetMs}ms. READ THE STATEMENT BELOW — it names ` +
        `which of the two regressions this is:\n` +
        `  · an "update …" ⇒ THE EXPLICIT LOCK IS MISSING (or was moved after the aggregate ` +
        `read), so the recompute computes FIRST and only blocks later, on its own UPDATE;\n` +
        `  · a "select … for update" ⇒ THE LOCK WAS STRENGTHENED. FOR UPDATE conflicts with ` +
        `the FOR KEY SHARE that Postgres's RI trigger takes on expert_profiles for every FK ` +
        `child insert, which blocks openSession and engagement creation. Use FOR NO KEY ` +
        `UPDATE — it still conflicts with itself, which is all the fix needs.\n` +
        `Last statement seen while blocked: ${lastSeenQuery}`
    );
  }
  throw new Error(
    `backend ${waiterPid} never blocked on backend ${holderPid} within ${budgetMs}ms — the ` +
      `contention this test needs did not happen; see this file's header.`
  );
}

interface HeldTransaction<T> {
  /** What the repository call inside the still-open transaction returned. */
  result: T;
  /** COMMIT it, and wait for the commit to land. Safe to call more than once. */
  commit: () => Promise<void>;
}

/**
 * Run ONE repository call inside a transaction on `target` and leave that transaction
 * OPEN, holding whatever locks the call took, until `commit()` is called.
 *
 * This is what makes the interleaving deliberate: with the winner's transaction open, the
 * loser's recompute cannot do anything BUT block, so the race runs through the blocking
 * path rather than being decided by whichever packet arrived first.
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
      // Recorded, never re-thrown here: an unawaited rejection would surface as an
      // unhandled rejection if the test failed before reaching `commit()`.
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

/** One COMMITTED user, visible to every connection. */
async function seedUser(): Promise<string> {
  const unique = randomUUID();
  const [row] = await wardenDb
    .insert(schema.users)
    .values({
      workosId: `${EMAIL_PREFIX}${unique}`,
      email: `${EMAIL_PREFIX}${unique}@test.example`,
      firstName: 'Concurrency',
      lastName: 'Fixture',
    })
    .returning({ id: schema.users.id });
  if (row === undefined) {
    throw new Error('user insert failed');
  }
  seededUserIds.push(row.id);
  return row.id;
}

/**
 * One COMMITTED expert profile with a fresh owner, plus `engagementCount` COMMITTED
 * project engagements for it — each with its own client company and its own reviewer,
 * so two review writes land on DIFFERENT engagements and therefore never contend on the
 * `reviews` partial unique. Contending ONLY on the expert row is the whole point.
 */
async function seedExpertWithEngagements(engagementCount: number): Promise<{
  expertProfileId: string;
  engagements: Array<{ engagementId: string; reviewerUserId: string; companyId: string }>;
}> {
  const ownerUserId = await seedUser();
  const [profile] = await wardenDb
    .insert(schema.expertProfiles)
    .values({ userId: ownerUserId, verticalId, type: 'freelancer' })
    .returning({ id: schema.expertProfiles.id });
  if (profile === undefined) {
    throw new Error('expert profile insert failed');
  }
  seededExpertProfileIds.push(profile.id);

  const engagements: Array<{ engagementId: string; reviewerUserId: string; companyId: string }> =
    [];
  for (let index = 0; index < engagementCount; index += 1) {
    const [company] = await wardenDb
      .insert(schema.companies)
      .values({ name: `Concurrency Co ${randomUUID()}`, isPersonal: true })
      .returning({ id: schema.companies.id });
    if (company === undefined) {
      throw new Error('company insert failed');
    }
    seededCompanyIds.push(company.id);

    const [engagement] = await wardenDb
      .insert(schema.engagements)
      .values({
        engagementType: 'project',
        companyId: company.id,
        expertProfileId: profile.id,
        activatedAt: new Date(),
      })
      .returning({ id: schema.engagements.id });
    if (engagement === undefined) {
      throw new Error('engagement insert failed');
    }

    const reviewerUserId = await seedUser();
    await wardenDb.insert(schema.companyMembers).values({
      companyId: company.id,
      userId: reviewerUserId,
      role: 'member',
      joinMethod: 'personal_workspace',
    });

    engagements.push({ engagementId: engagement.id, reviewerUserId, companyId: company.id });
  }

  return { expertProfileId: profile.id, engagements };
}

function upsertInput(
  seed: { expertProfileId: string },
  engagement: { engagementId: string; reviewerUserId: string },
  rating: number
): UpsertReviewInput {
  return {
    engagementId: engagement.engagementId,
    reviewerUserId: engagement.reviewerUserId,
    expertProfileId: seed.expertProfileId,
    rating,
    body: null,
    surface: 'end_of_call',
    authMethod: 'session',
  };
}

/**
 * What every OTHER connection can see for this expert — i.e. what actually got committed.
 *
 * `rating_average` is `numeric`, so it comes back as a STRING; asserted as one, because
 * `'3.0'` can only come from `numeric(2,1)` and a number would hide the rounding.
 */
async function committedAggregate(
  expertProfileId: string
): Promise<{ ratingAverage: string | null; ratingCount: number }> {
  const [row] = await wardenDb
    .select({
      ratingAverage: schema.expertProfiles.ratingAverage,
      ratingCount: schema.expertProfiles.ratingCount,
    })
    .from(schema.expertProfiles)
    .where(eq(schema.expertProfiles.id, expertProfileId));
  if (row === undefined) {
    throw new Error(`expert profile ${expertProfileId} not found on the committed view`);
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

  // ⚠ THE PREMISE OF THE WHOLE FILE, ASSERTED RATHER THAN ASSUMED. If a refactor ever
  // collapsed these onto one backend, `pg_blocking_pids` — which never reports a backend
  // as blocking ITSELF — would simply never name the holder, and the forced case would
  // burn its 10s poll budget and fail with "never blocked", pointing at the race instead
  // of at the real cause.
  expect(new Set([winnerPid, loserPid]).size).toBe(2);

  const [vertical] = await wardenDb
    .select({ id: schema.verticals.id })
    .from(schema.verticals)
    .where(eq(schema.verticals.slug, 'salesforce'));
  if (vertical === undefined) {
    throw new Error('the salesforce vertical seeded by global-setup is missing');
  }
  verticalId = vertical.id;
});

/**
 * Delete everything this file committed, in the ONE order the foreign keys permit.
 *
 * ⚠ THE ORDER IS LOAD-BEARING AND MOST OF IT IS NOT CASCADE. Reading outward:
 *   · `engagements` first — its delete CASCADES `reviews`, which is the only way those
 *     rows can go, because `reviews.reviewer_user_id` is ON DELETE **RESTRICT**;
 *   · `expert_profiles` next — `expert_profiles.user_id` has no cascade, so a profile
 *     still standing pins its owner;
 *   · `audit_events` next — `actor_user_id` is ON DELETE **RESTRICT** and every `upsert`
 *     writes one, so a review write pins its reviewer until the audit row is gone;
 *   · `company_members` before `companies` — that FK is NOT cascade either;
 *   · `users` last, once nothing points at them.
 *
 * ⚠ AND IT MUST NOT THROW. `setup-integration.ts` registers its own `afterEach` (which
 * ROLLS BACK the harness transaction) FIRST, so vitest runs it LAST — a throw here means
 * the harness transaction is never rolled back, its `max: 1` connection stays pinned, and
 * every subsequent `beforeEach` in the run queues behind it until the hook timeout. One
 * wrong delete order therefore does not fail one test, it hangs the file.
 */
async function deleteSeededRows(): Promise<void> {
  const expertIds = seededExpertProfileIds.splice(0);
  const companyIds = seededCompanyIds.splice(0);
  const userIds = seededUserIds.splice(0);

  if (expertIds.length > 0) {
    await wardenDb
      .delete(schema.engagements)
      .where(inArray(schema.engagements.expertProfileId, expertIds));
    await wardenDb
      .delete(schema.expertProfiles)
      .where(inArray(schema.expertProfiles.id, expertIds));
  }
  if (userIds.length > 0) {
    await wardenDb
      .delete(schema.auditEvents)
      .where(inArray(schema.auditEvents.actorUserId, userIds));
  }
  if (companyIds.length > 0) {
    await wardenDb
      .delete(schema.companyMembers)
      .where(inArray(schema.companyMembers.companyId, companyIds));
    await wardenDb.delete(schema.companies).where(inArray(schema.companies.id, companyIds));
  }
  if (userIds.length > 0) {
    await wardenDb.delete(schema.users).where(inArray(schema.users.id, userIds));
  }
}

afterEach(async () => {
  // ⚠ ORDER IS LOAD-BEARING, ALL THREE STEPS.
  // 1. Release any transaction a failed assertion left open — otherwise the cleanup
  //    statements would themselves block on the stranded row lock and burn the hook timeout.
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
  // otherwise outlive this file for the container's lifetime. Failure here must still not
  // skip the `end()` calls, or the run leaks connections.
  await deleteSeededRows().catch(() => undefined);
  // `end()` without a timeout waits indefinitely on an in-flight query; bound it so a
  // stuck statement becomes a fast close rather than a hook timeout.
  await Promise.all([
    winnerClient?.end({ timeout: 5 }),
    loserClient?.end({ timeout: 5 }),
    wardenClient?.end({ timeout: 5 }),
  ]);
});

describe('reviewsRepository.upsert — the rating aggregate under real concurrency', () => {
  /**
   * ⚠⚠ THE ONE THAT CARRIES THE PROOF.
   *
   * T1 writes a 5 on engagement A and is held open, so its `FOR UPDATE` on the expert row
   * is taken and uncommitted. T2 then writes a 1 on engagement B — a DIFFERENT engagement,
   * so the `reviews` partial unique lets it insert freely — and reaches
   * `recomputeRatingAggregate`, where it must block on T1's expert-row lock. That block is
   * asserted through `pg_blocking_pids`, not assumed, and it is simultaneously the
   * assertion that the `FOR UPDATE` still exists at all.
   *
   * Only then does T1 commit. T2 is granted the lock and issues its aggregate as a NEW
   * statement, which under READ COMMITTED takes a FRESH snapshot — one that now includes
   * T1's committed 5. So T2 stores the average over BOTH: 3.0 across 2 engagements.
   *
   * The three candidate outcomes are all distinguishable, which is why this fixture:
   *   3.0 / 2  — correct: both reviews seen.
   *   1.0 / 1  — THE LOST UPDATE: T2 wrote the aggregate it computed before T1 committed.
   *   5.0 / 1  — T1's value survived; T2's write was lost the other way round.
   */
  it('a second review write that BLOCKS on the expert row lock recomputes over the winner’s committed row', async () => {
    const seed = await seedExpertWithEngagements(2);
    const [engagementA, engagementB] = seed.engagements;
    if (engagementA === undefined || engagementB === undefined) {
      throw new Error('expected two seeded engagements');
    }

    // T1: the REAL write path on the FIRST engagement, held open on its expert-row lock.
    const held = await holdOpen(winnerDb, (tx) =>
      reviewsRepository.upsert(upsertInput(seed, engagementA, 5), tx)
    );
    expect(held.result.created).toBe(true);
    // Not yet visible to anyone else — the winner has not committed.
    expect(await committedAggregate(seed.expertProfileId)).toEqual({
      ratingAverage: null,
      ratingCount: 0,
    });

    // T2: the REAL production write path, on the SECOND engagement. Issued, NOT awaited —
    // it must be in flight and blocked before the winner commits.
    const contending = contend(
      reviewsRepository.upsert(upsertInput(seed, engagementB, 1), loserDb)
    );

    // THE GATE IS THE CALL, NOT AN `expect`. It returns only once Postgres has named
    // `winnerPid` as the blocker, and throws otherwise — including when the `FOR UPDATE`
    // has been removed, which is the regression this whole file exists to catch.
    await waitUntilBlockedBy(loserPid, winnerPid);

    await held.commit();
    await contending;

    expect(await committedAggregate(seed.expertProfileId)).toEqual({
      ratingAverage: '3.0', // (5 + 1) / 2 — BOTH engagements
      ratingCount: 2,
    });
  });

  /**
   * ⚠⚠ THE MECHANISM TEST — THE ONE THAT EXHAUSTS ITS POLL BUDGET IF THE EXPLICIT LOCK IS
   * DELETED. The case above proves the OUTCOME (no lost update); this one proves the
   * recompute takes a row lock BEFORE the aggregate read, which is the only reason the
   * outcome holds.
   *
   * ⚠⚠ IT WAS REWRITTEN BY BAL-422's FIX ROUND, AND THE OLD VERSION WOULD NOW BE ACTIVELY
   * HARMFUL — READ THIS BEFORE "RESTORING" IT. It used to hold a bare `FOR KEY SHARE` as
   * the probe, exploiting the one gap in Postgres's row-lock conflict matrix:
   *
   *              held: FOR KEY SHARE
   *   FOR UPDATE           → CONFLICTS   (the explicit lock, back when it was FOR UPDATE)
   *   FOR NO KEY UPDATE    → no conflict (what a plain UPDATE of non-key columns takes)
   *
   * That worked, but it CEMENTED `FOR UPDATE` as the required strength — and `FOR UPDATE`
   * is precisely what the security review struck, because it conflicts with the `FOR KEY
   * SHARE` Postgres's RI trigger takes on `expert_profiles` for every insert into a table
   * that FKs it (`engagements`, `credit_sessions`, `consultations`, `availability_rules`,
   * …). A review write holding it blocks a live consultation start. A test that DEMANDS an
   * over-strong lock is a test that blocks its own fix.
   *
   * ⚠ SO THE DISCRIMINATOR MOVED FROM "WHICH LOCK" TO "WHICH STATEMENT". With the explicit
   * lock now `FOR NO KEY UPDATE` — the SAME strength a non-key `UPDATE` takes — no held
   * lock strength can separate the recompute's two statements: anything that blocks the
   * locking `SELECT` blocks the `UPDATE` too. So the probe is a plain `FOR UPDATE` (which
   * conflicts with both), and the evidence is `pg_stat_activity.query`: the test waits for
   * the loser to be blocked by the winner *while executing a statement that is a `SELECT …
   * FOR NO KEY UPDATE`*.
   *
   *   · lock PRESENT  → the loser parks on that SELECT until the probe releases. Observed,
   *                     and the case passes.
   *   · lock REMOVED  → the loser computes the aggregate unblocked, then parks on its own
   *                     `UPDATE …`. The blocked statement never matches, the 10s budget is
   *                     exhausted, and the failure names the missing lock and prints the
   *                     statement it DID see. Verified by deleting the line and running it.
   *
   * That is a strictly stronger claim than the old one, not a weaker one: it pins the
   * ORDERING directly (which statement blocks) instead of inferring it from a lock strength
   * that also had to be over-specified to be inferable.
   *
   * ⚠ IF YOU CHANGE THE EXPLICIT LOCK'S STRENGTH, CHANGE {@link LOCKING_READ_PATTERN} WITH
   * IT — otherwise this silently degrades into "never observed", i.e. a permanent red.
   */
  it('the recompute takes a row lock BEFORE it reads — it is the locking SELECT that blocks, not the UPDATE', async () => {
    const seed = await seedExpertWithEngagements(0);

    // A bare FOR UPDATE on the expert row: it writes nothing, and it conflicts with BOTH of
    // the recompute's statements. Deliberately not a strength probe — which statement gets
    // stuck behind it is what this case reads.
    const held = await holdOpen(winnerDb, (tx) =>
      tx
        .select({ id: schema.expertProfiles.id })
        .from(schema.expertProfiles)
        .where(eq(schema.expertProfiles.id, seed.expertProfileId))
        .for('update')
    );
    expect(held.result).toHaveLength(1);

    const contending = contend(
      reviewsRepository.recomputeRatingAggregate(seed.expertProfileId, loserDb)
    );

    // THE GATE, AND THE ASSERTION. Returning at all means Postgres reported the loser as
    // blocked by the winner *on the locking SELECT* — i.e. the lock was taken before the
    // aggregate was read. Delete `.for('no key update')` and this throws with the budget
    // exhausted and the `update …` it saw instead.
    await waitUntilBlockedBy(loserPid, winnerPid, {
      pattern: LOCKING_READ_PATTERN,
      describe: 'the recompute’s locking SELECT (… for no key update)',
    });

    await held.commit();
    // …and it still completes correctly once the probe releases.
    await expect(contending).resolves.toEqual({ ratingAverage: null, ratingCount: 0 });
  });

  /**
   * THE OTHER HALF OF THE SECURITY FIX, PINNED SEPARATELY: the recompute must NOT block a
   * `FOR KEY SHARE` holder, because that is the lock Postgres's RI trigger takes on the
   * `expert_profiles` row for EVERY insert into a table that FKs it. `openSession` (a live
   * consultation start), engagement creation and availability writes all sit behind it.
   *
   * ⚠ THIS IS THE REGRESSION GUARD FOR "SOMEONE STRENGTHENS THE LOCK BACK TO FOR UPDATE".
   * The case above would still pass if they did — `FOR UPDATE` also matches nothing in
   * {@link LOCKING_READ_PATTERN}, so it would go red there too, but only by accident of the
   * pattern. THIS case fails for the RIGHT reason: with `FOR UPDATE` the insert below waits
   * on the held recompute and this test times out on a real, product-visible block.
   *
   * Construction, in three steps, because "it did not block" is an ABSENCE and an absence
   * is exactly the kind of claim that passes vacuously:
   *   1. hold the recompute OPEN on the winner, so its expert-row lock is live and
   *      uncommitted (the recompute nests a SAVEPOINT when handed a transaction handle, and
   *      Postgres TRANSFERS a subtransaction's row locks to the parent on release — so the
   *      lock outlives the recompute's own return, which is what makes this holdable);
   *   2. on the loser, insert an `engagements` row naming that expert — an FK child, so
   *      Postgres's RI trigger takes `FOR KEY SHARE` on the parent. It must COMPLETE;
   *   3. then, on that same loser, ask for a lock that DOES conflict, and observe it block
   *      on the winner. That is the anti-vacuity step: it proves the winner's lock was
   *      still live on the very connection that just sailed through step 2, so step 2's
   *      success cannot be explained by the lock having quietly gone away.
   */
  it('does NOT block an FK child insert — a held recompute leaves FOR KEY SHARE free', async () => {
    const seed = await seedExpertWithEngagements(0);

    const held = await holdOpen(winnerDb, (tx) =>
      reviewsRepository.recomputeRatingAggregate(seed.expertProfileId, tx)
    );
    expect(held.result).toEqual({ ratingAverage: null, ratingCount: 0 });

    const [company] = await wardenDb
      .insert(schema.companies)
      .values({ name: `Concurrency Co ${randomUUID()}`, isPersonal: true })
      .returning({ id: schema.companies.id });
    if (company === undefined) {
      throw new Error('company insert failed');
    }
    seededCompanyIds.push(company.id);

    // ⚠ ON `loserDb`, NOT `wardenDb`: it must be a DIFFERENT backend from the one holding
    // the recompute open, or "it did not have to wait" would be trivially true. Strengthen
    // the recompute's lock back to FOR UPDATE and this await never returns — the case then
    // fails on the test timeout, which is the product-visible outage in miniature.
    await loserDb.insert(schema.engagements).values({
      engagementType: 'project',
      companyId: company.id,
      expertProfileId: seed.expertProfileId,
      activatedAt: new Date(),
    });

    // Step 3 — THE ANTI-VACUITY CHECK. A conflicting request from the same backend, issued
    // and not awaited, must block on the winner. If this ever stops blocking, the premise of
    // the whole case has evaporated (the winner is no longer holding anything) and it fails
    // here rather than passing for the wrong reason.
    const conflicting = contend(
      loserDb
        .select({ id: schema.expertProfiles.id })
        .from(schema.expertProfiles)
        .where(eq(schema.expertProfiles.id, seed.expertProfileId))
        .for('no key update')
    );
    await waitUntilBlockedBy(loserPid, winnerPid);

    await held.commit();
    await conflicting;

    // The child row really landed, on its own connection, while the recompute was still
    // uncommitted — so this is a genuine FK-child insert, not a no-op that trivially passes.
    const rows = await wardenDb
      .select({ id: schema.engagements.id })
      .from(schema.engagements)
      .where(eq(schema.engagements.expertProfileId, seed.expertProfileId));
    expect(rows).toHaveLength(1);
  });

  /**
   * The UNFORCED race: both writes are in flight before either reply is read, on two
   * backends, against one committed expert row.
   *
   * ⚠ READ THE NAME LITERALLY: DISPATCHED TOGETHER IS NOT THE SAME AS CONTENDED. Whether
   * the second write actually waits on the first is up to Postgres — most of the time the
   * first transaction has already committed by the time the second reaches the lock, which
   * degrades this into the cross-connection form of the sequential suite's case. The
   * assertion holds for every interleaving, so this never flakes; it just proves less than
   * "simultaneous" would suggest, with nothing in the output to say which happened. That
   * is exactly why the case ABOVE exists and why it, not this one, is the proof. Kept for
   * its own narrow value: the only cross-connection check that two real backends can both
   * drive `upsert` against one expert row and still agree on the result.
   */
  it('two review writes DISPATCHED TOGETHER on two connections converge (interleaving NOT forced — see the previous case)', async () => {
    const seed = await seedExpertWithEngagements(2);
    const [engagementA, engagementB] = seed.engagements;
    if (engagementA === undefined || engagementB === undefined) {
      throw new Error('expected two seeded engagements');
    }

    await Promise.all([
      reviewsRepository.upsert(upsertInput(seed, engagementA, 5), winnerDb),
      reviewsRepository.upsert(upsertInput(seed, engagementB, 1), loserDb),
    ]);

    expect(await committedAggregate(seed.expertProfileId)).toEqual({
      ratingAverage: '3.0',
      ratingCount: 2,
    });
  });

  /**
   * TWO REVIEWERS ON **ONE** ENGAGEMENT, raced. Same lock, but the outcome is different
   * in a way worth pinning: per-engagement weighting means the count stays 1 no matter how
   * the two interleave, and the average is the average WITHIN that one engagement.
   *
   * ⚠ These two DO also contend on the `reviews` partial unique? NO — the arbiter covers
   * (engagement, REVIEWER, expert) and the reviewers differ, so the only shared lock is
   * still the expert row. That is what makes this a second, independent exercise of it.
   */
  it('two reviewers racing on ONE engagement still store rating_count = 1', async () => {
    const seed = await seedExpertWithEngagements(1);
    const [engagement] = seed.engagements;
    if (engagement === undefined) {
      throw new Error('expected one seeded engagement');
    }
    const secondReviewerUserId = await seedUser();
    await wardenDb.insert(schema.companyMembers).values({
      companyId: engagement.companyId,
      userId: secondReviewerUserId,
      role: 'member',
      joinMethod: 'personal_workspace',
    });

    await Promise.all([
      reviewsRepository.upsert(upsertInput(seed, engagement, 5), winnerDb),
      reviewsRepository.upsert(
        upsertInput(seed, { ...engagement, reviewerUserId: secondReviewerUserId }, 1),
        loserDb
      ),
    ]);

    expect(await committedAggregate(seed.expertProfileId)).toEqual({
      ratingAverage: '3.0', // (5 + 1) / 2 WITHIN the one engagement
      ratingCount: 1, // …which is still ONE vote
    });
  });
});
