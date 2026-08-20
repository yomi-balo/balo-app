import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, or } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../schema';
import type { Database } from '../client';
import type { DbExecutor } from './_shared/db-executor';
import { creditSessionsRepository, type SettleFromPresenceRepoInput } from './credit-sessions';

/**
 * ⚠⚠ THE LOAD-BEARING-CLAIM PROOF for `settleFromPresence` (BAL-412, plan §2.5/§Q6) — TWO
 * GENUINELY SIMULTANEOUS POSTGRES BACKENDS calling it on the SAME session.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `credit-sessions.integration.test.ts`. That suite
 * writes every settlement through the harness's single `max: 1` connection inside one open
 * transaction (`test/setup-integration.ts`), so it can only ever run two `settleFromPresence`
 * calls SEQUENTIALLY. It proves the ARITHMETIC AND THE MARKERS ARE RIGHT. It cannot touch the
 * question this file answers: whether `FOR UPDATE` + the in-lock `billingFinalizedAt` guard
 * ACTUALLY serializes two overlapping callers, or whether both terminal paths (the human End
 * and the lifecycle sweep) calling this best-effort at the same instant can double-settle a
 * session — post two sets of `session_consume` ticks, release the hold twice, or double the
 * expert accrual.
 *
 * ⚠ THE CLAIM UNDER TEST IS THE WHOLE IDEMPOTENCY DESIGN, ON THE MONEY PATH (orchestrator
 * decision Q6). `settleFromPresence`'s docblock states it: "TWO GENUINELY SIMULTANEOUS
 * backends" is exactly what this file drives, via the `exec` parameter that method's docblock
 * says exists FOR THIS TEST — the standard harness's `max: 1` pool cannot express it at all
 * (memory `reference_db_integration_harness_no_concurrency`).
 *
 * HARNESS RELATIONSHIP + SEEDING. Identical posture to `reviews.concurrency.integration.test.ts`
 * — read there first. `setupFiles` still runs (its `beforeEach` rebinds the module-level `db`
 * to a per-test transaction on the HARNESS's own connection); nothing below uses that `db`,
 * directly or via a factory, because every shared factory in `packages/db/src/test/factories`
 * is hard-wired to it and a row inserted there is invisible to the three raw connections this
 * file drives. Every row here is seeded, read and deleted through `winnerClient` / `loserClient`
 * / `wardenClient` instead, and cleanup is explicit.
 *
 * ⚠ `creditSessionsRepository.open()` is NOT used to seed the session — it takes no executor
 * override (always runs on the harness-bound module `db`), so it cannot write a row visible to
 * these three connections either. The session (and its wallet / hold / meeting / expert /
 * company / users) is inserted RAW, mirroring the reviews file's approach.
 */

type PgClient = ReturnType<typeof postgres>;

/** Every user this file commits carries this prefix, so cleanup can be exact. */
const EMAIL_PREFIX = 'credit-settlement-concurrency-';

/** Poll budget for "is the loser blocked yet?". 400 × 25ms = 10s, inside the 30s timeout. */
const BLOCK_POLL_INTERVAL_MS = 25;
const BLOCK_POLL_ATTEMPTS = 400;

/**
 * Three independent connections, each its own Postgres backend — same roles as the reviews
 * concurrency file:
 *   · `winner` — takes the first `settleFromPresence` call and holds its transaction open;
 *   · `loser`  — the contending `settleFromPresence` call, which must block on the session
 *     row's `FOR UPDATE` lock;
 *   · `warden` — seeds, observes `pg_blocking_pids`, asserts committed state, cleans up.
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
const seededSessionIds: string[] = [];
const seededHoldIds: string[] = [];
const seededMeetingIds: string[] = [];
const seededWalletIds: string[] = [];
const seededExpertProfileIds: string[] = [];
const seededCompanyIds: string[] = [];
const seededUserIds: string[] = [];

/** Held transactions still open, so a failed assertion cannot strand a row lock. */
const openHolds: Array<() => Promise<void>> = [];

/**
 * Contending statements issued but not yet awaited, so cleanup can wait for them — see the
 * reviews concurrency file's identical `contend`/`inFlight` pair for the orphan-write hazard
 * this closes.
 */
const inFlight: Array<Promise<unknown>> = [];

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
 * Block until Postgres reports `waiterPid` as waiting on a lock held by `holderPid`. Identical
 * mechanism to the reviews concurrency file's `waitUntilBlockedBy` (without the `onStatement`
 * discriminator — `settleFromPresence` takes exactly one row lock worth probing here, the
 * `readSessionForUpdate` `FOR UPDATE` on `credit_sessions`, so there is nothing to disambiguate).
 *
 * ⚠ THIS CALL *IS* THE DETERMINISM — nothing here sleeps a fixed interval and hopes. Exhausting
 * the budget THROWS, naming the two backends, so a race that failed to materialise fails loudly
 * instead of quietly degrading into the sequential case.
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
      `contention this test needs did not happen. Either the FOR UPDATE row lock in ` +
      `readSessionForUpdate was removed/weakened, or settleFromPresence stopped taking it ` +
      `before the billingFinalizedAt guard.`
  );
}

interface HeldTransaction<T> {
  result: T;
  commit: () => Promise<void>;
}

/**
 * Run ONE repository call inside a transaction on `target` and leave that transaction OPEN,
 * holding whatever locks the call took, until `commit()` is called. Identical to the reviews
 * concurrency file's `holdOpen` — `settleFromPresence(input, tx)` opens its OWN nested
 * transaction on the handed-in `tx`, which Postgres runs as a SAVEPOINT; the row lock it takes
 * TRANSFERS to this outer transaction on release, which is what makes it holdable at all.
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

const EXPERT_RATE_MINOR_PER_HOUR = 12_000;
const EXPERT_RATE_MINOR_PER_MINUTE = 200;
const CLIENT_RATE_MINOR_PER_MINUTE = 250;
const FLOOR_MINUTES = 15;

/**
 * One fully-seeded, COMMITTED `duration_source='presence'` session ready to settle: a company
 * + wallet (funded well past the floor charge), an expert (fresh user + profile), an initiating
 * member, an ENDED meeting, and an ACTIVE hold. Every insert is RAW, on `wardenDb` — see the
 * module docblock for why.
 */
async function seedPresenceSession(): Promise<{
  sessionId: string;
  meetingId: string;
  holdId: string;
  walletId: string;
}> {
  const ownerUserId = await seedUser();
  const memberUserId = await seedUser();

  const [company] = await wardenDb
    .insert(schema.companies)
    .values({ name: `Concurrency Co ${randomUUID()}`, isPersonal: true })
    .returning({ id: schema.companies.id });
  if (company === undefined) throw new Error('company insert failed');
  seededCompanyIds.push(company.id);

  const [expertProfile] = await wardenDb
    .insert(schema.expertProfiles)
    .values({ userId: ownerUserId, verticalId, type: 'freelancer' })
    .returning({ id: schema.expertProfiles.id });
  if (expertProfile === undefined) throw new Error('expert profile insert failed');
  seededExpertProfileIds.push(expertProfile.id);

  const [wallet] = await wardenDb
    .insert(schema.creditWallets)
    .values({ companyId: company.id, balanceMinor: 500_000 })
    .returning({ id: schema.creditWallets.id });
  if (wallet === undefined) throw new Error('wallet insert failed');
  seededWalletIds.push(wallet.id);

  const [meeting] = await wardenDb
    .insert(schema.meetings)
    .values({
      status: 'ended',
      endedBy: 'system_idle',
      endedAt: new Date('2027-02-01T10:20:00.000Z'),
      scheduledStart: new Date('2027-02-01T10:00:00.000Z'),
      scheduledEnd: new Date('2027-02-01T10:30:00.000Z'),
    })
    .returning({ id: schema.meetings.id });
  if (meeting === undefined) throw new Error('meeting insert failed');
  seededMeetingIds.push(meeting.id);

  const [hold] = await wardenDb
    .insert(schema.creditHolds)
    .values({
      walletId: wallet.id,
      memberId: memberUserId,
      amountMinor: FLOOR_MINUTES * CLIENT_RATE_MINOR_PER_MINUTE,
      status: 'active',
    })
    .returning({ id: schema.creditHolds.id });
  if (hold === undefined) throw new Error('hold insert failed');
  seededHoldIds.push(hold.id);

  const [session] = await wardenDb
    .insert(schema.creditSessions)
    .values({
      walletId: wallet.id,
      companyId: company.id,
      expertProfileId: expertProfile.id,
      initiatingMemberId: memberUserId,
      holdId: hold.id,
      meetingId: meeting.id,
      status: 'active',
      durationSource: 'presence',
      estimatedMinutes: FLOOR_MINUTES,
      expertRateMinorPerHour: EXPERT_RATE_MINOR_PER_HOUR,
      clientRateMinorPerMinute: CLIENT_RATE_MINOR_PER_MINUTE,
      expertRateMinorPerMinute: EXPERT_RATE_MINOR_PER_MINUTE,
      effectiveCeilingMinor: 100_000,
    })
    .returning({ id: schema.creditSessions.id });
  if (session === undefined) throw new Error('credit session insert failed');
  seededSessionIds.push(session.id);

  return { sessionId: session.id, meetingId: meeting.id, holdId: hold.id, walletId: wallet.id };
}

/** A `no_show_client` settlement at the floor — the boring, common shape. */
function settlementInput(
  sessionId: string,
  meetingId: string,
  overrides: Partial<SettleFromPresenceRepoInput> = {}
): SettleFromPresenceRepoInput {
  return {
    sessionId,
    meetingId,
    billableMinutes: FLOOR_MINUTES,
    actualMinutes: FLOOR_MINUTES,
    billingFloorMinutes: FLOOR_MINUTES,
    topUpFromTickSeq: 1,
    topUpToTickSeq: FLOOR_MINUTES,
    // F2 — the TOCTOU anchor: the `last_tick_seq` the caller's arithmetic was computed from.
    // The seeded session never metered, so 0.
    minutesAlreadyDrawn: 0,
    shape: 'no_show_client',
    // ⚠ F14/R1 — `true`: `no_show_client` bills the floor FLAT, so the minimum is definitionally
    // what fixed the figure and the pure core can never emit `false` on this shape.
    floorApplied: true,
    outcome: 'no_show_client',
    actorUserId: null,
    now: new Date('2027-02-01T10:20:05.000Z'),
    ...overrides,
  };
}

/** Every `session_consume` ledger row for one session, as committed. */
async function consumeRows(
  sessionId: string
): Promise<Array<{ idempotencyKey: string; seq: number | null }>> {
  return wardenDb
    .select({ idempotencyKey: schema.creditLedger.idempotencyKey, seq: schema.creditLedger.seq })
    .from(schema.creditLedger)
    .where(
      and(
        eq(schema.creditLedger.sessionId, sessionId),
        eq(schema.creditLedger.reason, 'session_consume')
      )
    );
}

async function committedHoldStatus(holdId: string): Promise<string | undefined> {
  const [row] = await wardenDb
    .select({ status: schema.creditHolds.status })
    .from(schema.creditHolds)
    .where(eq(schema.creditHolds.id, holdId));
  return row?.status;
}

async function committedSession(sessionId: string) {
  const [row] = await wardenDb
    .select()
    .from(schema.creditSessions)
    .where(eq(schema.creditSessions.id, sessionId));
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

  winnerPid = await backendPid(winnerClient);
  loserPid = await backendPid(loserClient);

  // ⚠ THE PREMISE OF THE WHOLE FILE, ASSERTED RATHER THAN ASSUMED — see the reviews
  // concurrency file's identical guard for what silently breaks without it.
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
 * Delete everything this file committed, in the one order the RESTRICT foreign keys permit
 * (every FK touched here is RESTRICT, never CASCADE — see the module docblock's FK survey):
 * ledger rows → the session → the hold → the meeting → the wallet → the expert profile → the
 * company → the users.
 *
 * ⚠ AND IT MUST NOT THROW — see the reviews concurrency file's identical warning: a throw here
 * means the harness's OWN per-test transaction (a different connection) never gets the chance
 * to roll back cleanly downstream, and every later `beforeEach` in the run queues behind it.
 */
async function deleteSeededRows(): Promise<void> {
  const sessionIds = seededSessionIds.splice(0);
  const holdIds = seededHoldIds.splice(0);
  const meetingIds = seededMeetingIds.splice(0);
  const walletIds = seededWalletIds.splice(0);
  const expertIds = seededExpertProfileIds.splice(0);
  const companyIds = seededCompanyIds.splice(0);
  const userIds = seededUserIds.splice(0);

  // ⚠ AUDIT ROWS, FIRST AND WIDE. `applyLedgerEntry`'s member-attributed audit
  // (`recordCreditAudit`) writes `entity_id = wallet_id` (NOT `session_id`) and
  // `actor_user_id = memberId` — a real regression caught by actually running this file: a
  // cleanup scoped to `entityId IN sessionIds` alone leaves that row behind, and the `users`
  // delete below then fails on `audit_events_actor_user_id_users_id_fk`. So this catches every
  // shape settlement can write: `entity_id` on the session, the wallet, OR the meeting
  // (`meeting.outcome_resolved`), OR `actor_user_id` naming one of this file's own users
  // (belt-and-braces for a future non-null `actorUserId` test).
  const auditWhereClauses = [
    sessionIds.length > 0 ? inArray(schema.auditEvents.entityId, sessionIds) : undefined,
    walletIds.length > 0 ? inArray(schema.auditEvents.entityId, walletIds) : undefined,
    meetingIds.length > 0 ? inArray(schema.auditEvents.entityId, meetingIds) : undefined,
    userIds.length > 0 ? inArray(schema.auditEvents.actorUserId, userIds) : undefined,
  ].filter((clause) => clause !== undefined);
  if (auditWhereClauses.length > 0) {
    await wardenDb.delete(schema.auditEvents).where(or(...auditWhereClauses));
  }

  if (sessionIds.length > 0) {
    await wardenDb
      .delete(schema.creditLedger)
      .where(inArray(schema.creditLedger.sessionId, sessionIds));
    await wardenDb
      .delete(schema.creditSessions)
      .where(inArray(schema.creditSessions.id, sessionIds));
  }
  if (holdIds.length > 0) {
    await wardenDb.delete(schema.creditHolds).where(inArray(schema.creditHolds.id, holdIds));
  }
  if (meetingIds.length > 0) {
    await wardenDb.delete(schema.meetings).where(inArray(schema.meetings.id, meetingIds));
  }
  if (walletIds.length > 0) {
    await wardenDb.delete(schema.creditWallets).where(inArray(schema.creditWallets.id, walletIds));
  }
  if (expertIds.length > 0) {
    await wardenDb
      .delete(schema.expertProfiles)
      .where(inArray(schema.expertProfiles.id, expertIds));
  }
  if (companyIds.length > 0) {
    await wardenDb.delete(schema.companies).where(inArray(schema.companies.id, companyIds));
  }
  if (userIds.length > 0) {
    await wardenDb.delete(schema.users).where(inArray(schema.users.id, userIds));
  }
}

afterEach(async () => {
  // ⚠ ORDER IS LOAD-BEARING, ALL THREE STEPS — identical reasoning to the reviews file.
  for (const commit of openHolds.splice(0)) {
    await commit().catch(() => undefined);
  }
  await Promise.allSettled(inFlight.splice(0));
  await deleteSeededRows();
});

afterAll(async () => {
  await deleteSeededRows().catch(() => undefined);
  await Promise.all([
    winnerClient?.end({ timeout: 5 }),
    loserClient?.end({ timeout: 5 }),
    wardenClient?.end({ timeout: 5 }),
  ]);
});

describe('creditSessionsRepository.settleFromPresence — under real concurrency', () => {
  /**
   * ⚠⚠ THE ONE THAT CARRIES THE PROOF (Q6). T1 settles the session and is held open, so its
   * `FOR UPDATE` on the session row is taken and uncommitted. T2 — the OTHER best-effort
   * terminal path, in production — issues the identical settlement call on the SAME session
   * and must block on that lock. Only once Postgres reports the block (not assumed, not timed)
   * does T1 commit; T2 is then granted the lock, re-reads the row under READ COMMITTED's fresh
   * per-statement snapshot, sees `billing_finalized_at` already stamped, and takes the
   * `alreadySettled` short-circuit — touching NEITHER the ledger nor the hold.
   */
  it('two concurrent settlements on ONE session produce exactly ONE settlement, ONE hold release, NO duplicate ticks', async () => {
    const seed = await seedPresenceSession();
    const input = settlementInput(seed.sessionId, seed.meetingId);

    // T1: the REAL settlement path, held open on the session's row lock.
    const held = await holdOpen(winnerDb, (tx) =>
      creditSessionsRepository.settleFromPresence(input, tx)
    );
    expect(held.result.alreadySettled).toBe(false);
    expect(held.result.ticksPosted).toBe(FLOOR_MINUTES);
    expect(held.result.outcomeWritten).toBe(true);
    // Not yet visible to anyone else — the winner has not committed.
    expect(await consumeRows(seed.sessionId)).toEqual([]);
    expect(await committedHoldStatus(seed.holdId)).toBe('active');

    // T2: the REAL production settlement path, on the SAME session. Issued, NOT awaited — it
    // must be in flight and blocked before the winner commits.
    const contending = contend(creditSessionsRepository.settleFromPresence(input, loserDb));

    // THE GATE IS THE CALL, NOT AN `expect`. Throws (naming both backends) if the row lock was
    // ever removed or weakened — the exact regression this file exists to catch.
    await waitUntilBlockedBy(loserPid, winnerPid);

    await held.commit();
    const loserResult = await contending;

    // T2 took the in-lock idempotency short-circuit — no second settlement.
    expect(loserResult.alreadySettled).toBe(true);
    expect(loserResult.ticksPosted).toBe(0);
    expect(loserResult.outcomeWritten).toBe(false);

    // ONE settlement, committed.
    const session = await committedSession(seed.sessionId);
    expect(session?.status).toBe('ended');
    expect(session?.billingFinalizedAt).not.toBeNull();
    expect(session?.connectedMinutes).toBe(FLOOR_MINUTES);
    expect(session?.expertAccruedMinor).toBe(FLOOR_MINUTES * EXPERT_RATE_MINOR_PER_MINUTE);

    // NO DUPLICATE `session_consume` ROWS — 15 ticks, not 30, and every idempotency key unique.
    const rows = await consumeRows(seed.sessionId);
    expect(rows).toHaveLength(FLOOR_MINUTES);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(FLOOR_MINUTES);

    // ONE hold release — never twice, never left active.
    expect(await committedHoldStatus(seed.holdId)).toBe('released');
  });

  /**
   * THE UNFORCED race, for the same reason the reviews file keeps its own copy: it never
   * flakes (the assertion holds for every interleaving) but proves less than "simultaneous"
   * would suggest — kept as the only cross-connection check that two real backends can both
   * drive `settleFromPresence` on one session and still agree on exactly one outcome.
   */
  it('two settlements DISPATCHED TOGETHER on two connections still converge on exactly one outcome', async () => {
    const seed = await seedPresenceSession();
    const input = settlementInput(seed.sessionId, seed.meetingId);

    const [first, second] = await Promise.all([
      creditSessionsRepository.settleFromPresence(input, winnerDb),
      creditSessionsRepository.settleFromPresence(input, loserDb),
    ]);

    // Exactly one of the two actually settled; the other found it already done.
    const settledCount = [first, second].filter((result) => !result.alreadySettled).length;
    expect(settledCount).toBe(1);

    const rows = await consumeRows(seed.sessionId);
    expect(rows).toHaveLength(FLOOR_MINUTES);
    expect(await committedHoldStatus(seed.holdId)).toBe('released');
  });

  /**
   * ⚠⚠ F2 — THE OTHER CONCURRENT WRITER. The two cases above are settlement-vs-settlement; this
   * one is **METER-vs-settlement**, which is a different hazard entirely and was previously
   * uncovered here.
   *
   * `findMeterable` INCLUDES `'presence'` (D11), so the meter sweep is a DESIGNED concurrent
   * writer on `credit_sessions.last_tick_seq` — the exact column
   * `settleSessionFromPresence` pre-reads OUTSIDE any transaction to compute
   * `minutesAlreadyDrawn`. Between that pre-read and the settlement transaction the sweep can
   * commit further ticks, and settling on the stale figure would write `connected_minutes = 18`
   * while the LEDGER holds 20 draws — the row CONTRADICTING the source of truth (ADR-1040), the
   * expert accrued 18 of a 20-minute draw, the client's receipt understated, and the Q1
   * `log.error` firing with a stale number that reads as the benign known-limitation case.
   *
   * ⚠ IT IS DRIVEN ACROSS BACKENDS ON PURPOSE. The sibling suite's version of this case runs the
   * real `meterSessionToNow` (real ledger rows) but on ONE connection; in production the meter
   * sweep is a DIFFERENT PROCESS, so what actually has to hold is that the settlement's
   * `FOR UPDATE` re-read sees another backend's COMMITTED advance under READ COMMITTED. That is
   * what this drives: the warden commits the advance, and the winner's settlement must refuse.
   */
  it('⚠⚠ REFUSES a settlement whose minutesAlreadyDrawn was overtaken by ANOTHER BACKEND’s meter tick', async () => {
    const seed = await seedPresenceSession();

    // ── the caller's PRE-READ, on the settlement's own connection: 18 minutes drawn ──
    await wardenDb
      .update(schema.creditSessions)
      .set({ lastTickSeq: 18, connectedMinutes: 18 })
      .where(eq(schema.creditSessions.id, seed.sessionId));
    const [preRead] = await winnerDb
      .select({ lastTickSeq: schema.creditSessions.lastTickSeq })
      .from(schema.creditSessions)
      .where(eq(schema.creditSessions.id, seed.sessionId));
    expect(preRead?.lastTickSeq).toBe(18);

    const staleInput = settlementInput(seed.sessionId, seed.meetingId, {
      billableMinutes: 18,
      actualMinutes: 18,
      topUpFromTickSeq: 19,
      topUpToTickSeq: 18,
      minutesAlreadyDrawn: 18,
      shape: 'held',
      outcome: 'completed',
    });

    // ── …and the METER SWEEP, on a genuinely separate backend, COMMITS ticks 19-20 ──
    await wardenDb
      .update(schema.creditSessions)
      .set({ lastTickSeq: 20, connectedMinutes: 20 })
      .where(eq(schema.creditSessions.id, seed.sessionId));

    await expect(creditSessionsRepository.settleFromPresence(staleInput, winnerDb)).rejects.toThrow(
      /metered concurrently/
    );

    // NOTHING WAS WRITTEN. Not the terminal status, not the marker, not the hold release, not
    // one tick — and above all `connected_minutes` was not rolled BACK to the stale 18.
    const session = await committedSession(seed.sessionId);
    expect(session?.status).toBe('active');
    expect(session?.billingFinalizedAt).toBeNull();
    expect(session?.connectedMinutes).toBe(20);
    expect(session?.lastTickSeq).toBe(20);
    expect(await consumeRows(seed.sessionId)).toEqual([]);
    expect(await committedHoldStatus(seed.holdId)).toBe('active');

    // …and it is RECOVERABLE: the same call with the FRESH figure settles cleanly, which is
    // what makes refusing (rather than silently re-reading) safe — the durability backstop
    // simply retries.
    const fresh = await creditSessionsRepository.settleFromPresence(
      settlementInput(seed.sessionId, seed.meetingId, {
        billableMinutes: 20,
        actualMinutes: 20,
        topUpFromTickSeq: 21,
        topUpToTickSeq: 20,
        minutesAlreadyDrawn: 20,
        shape: 'held',
        outcome: 'completed',
      }),
      winnerDb
    );
    expect(fresh.alreadySettled).toBe(false);
    expect(fresh.session.connectedMinutes).toBe(20);
    expect(fresh.session.expertAccruedMinor).toBe(20 * EXPERT_RATE_MINOR_PER_MINUTE);
    expect(await committedHoldStatus(seed.holdId)).toBe('released');
  });
});
