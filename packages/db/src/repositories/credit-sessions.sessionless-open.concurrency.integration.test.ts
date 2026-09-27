import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../schema';
import type { Database } from '../client';
import type { DbExecutor } from './_shared/db-executor';
import {
  creditSessionsRepository,
  type OpenAndSettleFromPresenceInput,
  type OpenSessionInput,
} from './credit-sessions';

/**
 * ⚠⚠ THE LOAD-BEARING-CLAIM PROOF for "never two sessions per meeting" (BAL-474, ADR-1040
 * Amendment 7 §C.5 / plan AD-3 + AD-4) — TWO GENUINELY SIMULTANEOUS POSTGRES BACKENDS opening a
 * session for the SAME meeting.
 *
 * A sessionless Case meeting is opened-and-settled in ONE transaction
 * (`openAndSettleFromPresence`) from every terminal path — the lifecycle sweep, a human End and
 * the durability backstop — and a client/guest admission can open a pending session for the same
 * meeting at any moment. All of them serialise on the ONE wallet advisory lock (every session of a
 * meeting sits on the engagement company's single wallet), and `open()`'s in-lock step 1b refuses
 * a second live (non-cancelled, ended-or-not) session for the meeting. There is deliberately NO
 * unique index (BAL-466's ruling), so the lock-plus-check is the whole guarantee — and the
 * standard harness (one `max: 1` connection inside one open transaction) cannot exercise it.
 *
 * Same harness posture as `credit-sessions.settlement.concurrency.integration.test.ts` — read
 * there first: three raw connections, every row seeded COMMITTED on the warden, the contender's
 * block observed via `pg_blocking_pids` (never a sleep), explicit cleanup.
 *
 * The dunning claim race is NOT here (plan V4-F8): it needs `apps/api`'s `notify.ts` and lives in
 * `apps/api/src/jobs/receivable-dunning-sweep.integration.test.ts`.
 */

type PgClient = ReturnType<typeof postgres>;

const EMAIL_PREFIX = 'sessionless-open-concurrency-';
const BLOCK_POLL_INTERVAL_MS = 25;
const BLOCK_POLL_ATTEMPTS = 400;
const MINUTE_MS = 60_000;
const FLOOR_MINUTES = 15;
const EXPERT_RATE_MINOR_PER_HOUR = 12_000;

let winnerClient: PgClient;
let loserClient: PgClient;
let wardenClient: PgClient;
let winnerDb: Database;
let loserDb: Database;
let wardenDb: Database;
let winnerPid: number;
let loserPid: number;
let verticalId: string;

const seededMeetingIds: string[] = [];
const seededEngagementIds: string[] = [];
const seededWalletIds: string[] = [];
const seededExpertProfileIds: string[] = [];
const seededCompanyIds: string[] = [];
const seededUserIds: string[] = [];
const openHolds: Array<() => Promise<void>> = [];
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

/** Block until Postgres reports `waiterPid` waiting on a lock held by `holderPid`. */
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
      `${BLOCK_POLL_ATTEMPTS * BLOCK_POLL_INTERVAL_MS}ms — the contention this test needs did not ` +
      'happen. Either the wallet advisory lock stopped being the FIRST statement of the open, or ' +
      'the two calls no longer share one wallet.'
  );
}

interface HeldTransaction<T> {
  result: T;
  commit: () => Promise<void>;
}

/** Run ONE repository call inside a transaction on `target`, left OPEN until `commit()`. */
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

async function seedUser(): Promise<string> {
  const unique = randomUUID();
  const [row] = await wardenDb
    .insert(schema.users)
    .values({
      workosId: `${EMAIL_PREFIX}${unique}`,
      email: `${EMAIL_PREFIX}${unique}@test.example`,
      firstName: 'Sessionless',
      lastName: 'Fixture',
    })
    .returning({ id: schema.users.id });
  if (row === undefined) throw new Error('user insert failed');
  seededUserIds.push(row.id);
  return row.id;
}

interface Seed {
  walletId: string;
  companyId: string;
  expertProfileId: string;
  bookerId: string;
  meetingId: string;
  engagementId: string;
}

/**
 * One COMMITTED sessionless Case meeting ready to settle: a company + funded wallet, an expert
 * with a rate, the booker (the on-behalf attribution), a Case engagement and an ENDED meeting.
 * Every insert is RAW, on the warden — the shared factories are hard-wired to the harness's own
 * per-test transaction and are invisible to these connections.
 */
async function seedSessionlessMeeting(): Promise<Seed> {
  const expertUserId = await seedUser();
  const bookerId = await seedUser();

  const [company] = await wardenDb
    .insert(schema.companies)
    .values({ name: `Sessionless Co ${randomUUID()}`, isPersonal: true })
    .returning({ id: schema.companies.id });
  if (company === undefined) throw new Error('company insert failed');
  seededCompanyIds.push(company.id);

  const [expertProfile] = await wardenDb
    .insert(schema.expertProfiles)
    .values({
      userId: expertUserId,
      verticalId,
      type: 'freelancer',
      rateCents: EXPERT_RATE_MINOR_PER_HOUR,
    })
    .returning({ id: schema.expertProfiles.id });
  if (expertProfile === undefined) throw new Error('expert profile insert failed');
  seededExpertProfileIds.push(expertProfile.id);

  const [wallet] = await wardenDb
    .insert(schema.creditWallets)
    .values({ companyId: company.id, balanceMinor: 500_000 })
    .returning({ id: schema.creditWallets.id });
  if (wallet === undefined) throw new Error('wallet insert failed');
  seededWalletIds.push(wallet.id);

  const [engagement] = await wardenDb
    .insert(schema.engagements)
    .values({
      engagementType: 'case',
      companyId: company.id,
      expertProfileId: expertProfile.id,
      baloFeeBps: null,
      activatedAt: new Date(),
    })
    .returning({ id: schema.engagements.id });
  if (engagement === undefined) throw new Error('engagement insert failed');
  seededEngagementIds.push(engagement.id);

  const start = new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS - 60 * MINUTE_MS);
  const [meeting] = await wardenDb
    .insert(schema.meetings)
    .values({
      status: 'ended',
      endedBy: 'system_idle',
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 30 * MINUTE_MS),
      endedAt: new Date(start.getTime() + 20 * MINUTE_MS),
    })
    .returning({ id: schema.meetings.id });
  if (meeting === undefined) throw new Error('meeting insert failed');
  seededMeetingIds.push(meeting.id);

  return {
    walletId: wallet.id,
    companyId: company.id,
    expertProfileId: expertProfile.id,
    bookerId,
    meetingId: meeting.id,
    engagementId: engagement.id,
  };
}

function openAndSettleInput(seed: Seed): OpenAndSettleFromPresenceInput {
  return {
    open: {
      walletId: seed.walletId,
      companyId: seed.companyId,
      expertProfileId: seed.expertProfileId,
      initiatingMemberId: seed.bookerId,
      estimatedMinutes: 30,
      meetingId: seed.meetingId,
      engagementId: seed.engagementId,
      durationSource: 'presence',
      fundingPolicy: 'overdraft_tolerant',
      openedBy: 'system',
      trigger: 'backstop',
    },
    settlement: {
      billableMinutes: FLOOR_MINUTES,
      actualMinutes: FLOOR_MINUTES,
      billingFloorMinutes: FLOOR_MINUTES,
      topUpFromTickSeq: 1,
      topUpToTickSeq: FLOOR_MINUTES,
      minutesAlreadyDrawn: 0,
      shape: 'no_show_client',
      floorApplied: true,
      outcome: 'no_show_client',
      actorUserId: null,
      now: new Date(),
    },
  };
}

/** A client admission's tolerant open for the SAME meeting — the other entry point. */
function admissionOpenInput(seed: Seed): OpenSessionInput {
  return {
    walletId: seed.walletId,
    companyId: seed.companyId,
    expertProfileId: seed.expertProfileId,
    initiatingMemberId: seed.bookerId,
    estimatedMinutes: 30,
    meetingId: seed.meetingId,
    engagementId: seed.engagementId,
    durationSource: 'presence',
    fundingPolicy: 'overdraft_tolerant',
    openedBy: 'client',
  };
}

async function liveSessionsFor(meetingId: string): Promise<Array<{ id: string; status: string }>> {
  return wardenDb
    .select({ id: schema.creditSessions.id, status: schema.creditSessions.status })
    .from(schema.creditSessions)
    .where(
      and(
        eq(schema.creditSessions.meetingId, meetingId),
        ne(schema.creditSessions.status, 'cancelled')
      )
    );
}

async function consumeCountForMeeting(meetingId: string): Promise<number> {
  const rows = await wardenDb
    .select({ id: schema.creditLedger.id })
    .from(schema.creditLedger)
    .innerJoin(schema.creditSessions, eq(schema.creditSessions.id, schema.creditLedger.sessionId))
    .where(
      and(
        eq(schema.creditSessions.meetingId, meetingId),
        eq(schema.creditLedger.reason, 'session_consume')
      )
    );
  return rows.length;
}

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
    );
  }
  // `prepare: false` — the production driver configuration (memory: a named COMMIT silently
  // rolls back with prepared statements on).
  winnerClient = postgres(url, { max: 1, prepare: false });
  loserClient = postgres(url, { max: 1, prepare: false });
  wardenClient = postgres(url, { max: 1, prepare: false });
  winnerDb = drizzle(winnerClient, { schema });
  loserDb = drizzle(loserClient, { schema });
  wardenDb = drizzle(wardenClient, { schema });

  winnerPid = await backendPid(winnerClient);
  loserPid = await backendPid(loserClient);
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
 * Delete everything this file committed, in the order the RESTRICT foreign keys permit. The
 * sessions, holds, ledger rows and audit rows are created BY THE REPOSITORY (their ids are not
 * known up front), so they are found through the seeded wallet / meeting ids. The hold ↔ session
 * link is two-way, so the hold's `session_id` is nulled before either side is deleted. Must not
 * throw (see the settlement concurrency file's warning).
 */
async function deleteSeededRows(): Promise<void> {
  const meetingIds = seededMeetingIds.splice(0);
  const engagementIds = seededEngagementIds.splice(0);
  const walletIds = seededWalletIds.splice(0);
  const expertIds = seededExpertProfileIds.splice(0);
  const companyIds = seededCompanyIds.splice(0);
  const userIds = seededUserIds.splice(0);

  const sessionIds =
    walletIds.length === 0
      ? []
      : (
          await wardenDb
            .select({ id: schema.creditSessions.id })
            .from(schema.creditSessions)
            .where(inArray(schema.creditSessions.walletId, walletIds))
        ).map((row) => row.id);

  const auditWhereClauses = [
    sessionIds.length > 0 ? inArray(schema.auditEvents.entityId, sessionIds) : undefined,
    walletIds.length > 0 ? inArray(schema.auditEvents.entityId, walletIds) : undefined,
    meetingIds.length > 0 ? inArray(schema.auditEvents.entityId, meetingIds) : undefined,
    userIds.length > 0 ? inArray(schema.auditEvents.actorUserId, userIds) : undefined,
  ].filter((clause) => clause !== undefined);
  if (auditWhereClauses.length > 0) {
    await wardenDb.delete(schema.auditEvents).where(or(...auditWhereClauses));
  }

  if (walletIds.length > 0) {
    await wardenDb
      .delete(schema.creditLedger)
      .where(inArray(schema.creditLedger.walletId, walletIds));
    await wardenDb
      .update(schema.creditHolds)
      .set({ sessionId: null })
      .where(inArray(schema.creditHolds.walletId, walletIds));
    await wardenDb
      .delete(schema.creditSessions)
      .where(inArray(schema.creditSessions.walletId, walletIds));
    await wardenDb
      .delete(schema.creditHolds)
      .where(inArray(schema.creditHolds.walletId, walletIds));
  }
  if (meetingIds.length > 0) {
    await wardenDb.delete(schema.meetings).where(inArray(schema.meetings.id, meetingIds));
  }
  if (engagementIds.length > 0) {
    await wardenDb.delete(schema.engagements).where(inArray(schema.engagements.id, engagementIds));
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

describe('creditSessionsRepository — never two sessions per meeting, under real concurrency', () => {
  /**
   * ⚠⚠ Two terminal paths (say the lifecycle sweep and the backstop) open-and-settle the SAME
   * sessionless meeting at once. T1 is held open inside its transaction, so it holds the wallet
   * advisory lock with an uncommitted session; T2 must BLOCK on that lock (observed, not timed),
   * then — once T1 commits — see T1's session in step 1b and refuse, posting nothing.
   */
  it('two simultaneous openAndSettleFromPresence calls for one meeting ⇒ one ok, one meeting_session_exists; the FLOOR ticks once', async () => {
    const seed = await seedSessionlessMeeting();
    const input = openAndSettleInput(seed);

    const held = await holdOpen(winnerDb, (tx) =>
      creditSessionsRepository.openAndSettleFromPresence(input, tx as Database)
    );
    expect(held.result.ok).toBe(true);
    // Not yet visible to anyone else.
    expect(await liveSessionsFor(seed.meetingId)).toEqual([]);

    const contending = contend(creditSessionsRepository.openAndSettleFromPresence(input, loserDb));
    await waitUntilBlockedBy(loserPid, winnerPid);
    await held.commit();
    const loser = await contending;

    const sessions = await liveSessionsFor(seed.meetingId);
    expect(sessions).toHaveLength(1);
    const [winner] = sessions;
    expect(winner?.status).toBe('ended');
    expect(loser).toEqual({
      ok: false,
      code: 'meeting_session_exists',
      existingSessionId: winner?.id,
    });
    // The floor posted ONCE — 15 ticks, not 30.
    expect(await consumeCountForMeeting(seed.meetingId)).toBe(FLOOR_MINUTES);
  });

  /**
   * ⚠⚠ MIXED ENTRY (S4-F2) — a client admission's tolerant `open()` wins the wallet lock first and
   * commits a PENDING session; the terminal path's `openAndSettleFromPresence` for the same meeting
   * must then refuse with `meeting_session_exists` naming that pending row, and post no ticks. The
   * pending session is the one the terminal path then settles (`settleMeetingIfBillable`).
   */
  it('mixed entry: a tolerant open() that wins leaves exactly one row, and the open-and-settle returns meeting_session_exists naming it', async () => {
    const seed = await seedSessionlessMeeting();

    const held = await holdOpen(winnerDb, (tx) =>
      creditSessionsRepository.open(admissionOpenInput(seed), tx as Database)
    );
    expect(held.result.ok).toBe(true);
    const pendingId = held.result.ok ? held.result.session.id : undefined;

    const contending = contend(
      creditSessionsRepository.openAndSettleFromPresence(openAndSettleInput(seed), loserDb)
    );
    await waitUntilBlockedBy(loserPid, winnerPid);
    await held.commit();
    const loser = await contending;

    expect(loser).toEqual({
      ok: false,
      code: 'meeting_session_exists',
      existingSessionId: pendingId,
    });
    const sessions = await liveSessionsFor(seed.meetingId);
    expect(sessions).toEqual([{ id: pendingId, status: 'pending' }]);
    expect(await consumeCountForMeeting(seed.meetingId)).toBe(0);
  });

  it('mixed entry, reversed: an open-and-settle that wins makes the late admission open refuse', async () => {
    const seed = await seedSessionlessMeeting();

    const held = await holdOpen(winnerDb, (tx) =>
      creditSessionsRepository.openAndSettleFromPresence(openAndSettleInput(seed), tx as Database)
    );
    expect(held.result.ok).toBe(true);

    const contending = contend(creditSessionsRepository.open(admissionOpenInput(seed), loserDb));
    await waitUntilBlockedBy(loserPid, winnerPid);
    await held.commit();
    const loser = await contending;

    const sessions = await liveSessionsFor(seed.meetingId);
    expect(sessions).toHaveLength(1);
    const [winner] = sessions;
    expect(loser).toEqual({
      ok: false,
      code: 'meeting_session_exists',
      existingSessionId: winner?.id,
    });
    expect(await consumeCountForMeeting(seed.meetingId)).toBe(FLOOR_MINUTES);
  });
});
