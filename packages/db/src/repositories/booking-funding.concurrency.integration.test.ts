import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import type postgres from 'postgres';
import * as schema from '../schema';
import type { Database } from '../client';
import { createConcurrentDb, _setDb } from '../test/concurrent-client';
import { bookingFundingRepository, readSnapshotInTx } from './booking-funding';
import { creditSessionsRepository } from './credit-sessions';

/**
 * ⚠⚠ THE ONE-SNAPSHOT PROOF for `bookingFundingRepository.readSnapshot` (BAL-474, plan §I.7,
 * V1-F2 / V4-F8 / D8.5) — across TWO REAL CONNECTIONS.
 *
 * WHY THIS FILE EXISTS. The booking verdict sums the reservable (sessionless, upcoming) Case
 * bookings AND subtracts the wallet's holds from `available`. A meeting that opens its session
 * moves from the first figure to the second. If the two reads came from different moments, a
 * session committing between them would be counted TWICE (still reservable in one read, its hold
 * already inside `available` in the other) — the double-subtract that refuses a booking the
 * company can afford. The snapshot therefore reads everything in ONE `REPEATABLE READ` transaction
 * on ONE executor. Under the standard harness a nested `transaction()` is a SAVEPOINT that silently
 * drops the isolation config, so the property is only observable here: connection A takes a real
 * repeatable-read snapshot, connection B commits a session + hold for the upcoming meeting, and A's
 * snapshot must STILL reserve the meeting and NOT subtract B's hold.
 *
 * ⚠ MUTATION PROOF (recorded in the PR): make `getAvailableForBooking` sum its holds on the bare
 * `db` instead of the snapshot's executor, and the in-snapshot re-read below subtracts B's hold
 * while still reserving the meeting — this test fails.
 *
 * HARNESS. `_setDb` points the module `db` at a real, committing pool (`createConcurrentDb`), so a
 * read that escapes the snapshot's executor would land on a connection that SEES B's commit — which
 * is what makes the mutation observable. Every row is seeded RAW on a warden connection and deleted
 * explicitly (the shared factories are hard-wired to the harness transaction).
 */

type PgClient = ReturnType<typeof postgres>;

const EMAIL_PREFIX = 'booking-funding-concurrency-';
const MINUTE_MS = 60_000;
/** Client 700 / minute at the default fee ⇒ a 30-minute booking reserves 21,000. */
const EXPERT_HOURLY_700 = 33_600;

let aClient: PgClient;
let bClient: PgClient;
let wardenClient: PgClient;
let poolClient: PgClient;
let aDb: Database;
let bDb: Database;
let wardenDb: Database;
let poolDb: Database;
let verticalId: string;

const seededUserIds: string[] = [];
const seededCompanyIds: string[] = [];
const seededExpertProfileIds: string[] = [];
const seededWalletIds: string[] = [];
const seededEngagementIds: string[] = [];
const seededMeetingIds: string[] = [];

async function seedUser(): Promise<string> {
  const unique = randomUUID();
  const [row] = await wardenDb
    .insert(schema.users)
    .values({
      workosId: `${EMAIL_PREFIX}${unique}`,
      email: `${EMAIL_PREFIX}${unique}@test.example`,
      firstName: 'Booking',
      lastName: 'Snapshot',
    })
    .returning({ id: schema.users.id });
  if (row === undefined) throw new Error('user insert failed');
  seededUserIds.push(row.id);
  return row.id;
}

interface Seed {
  companyId: string;
  walletId: string;
  memberId: string;
  expertProfileId: string;
  engagementId: string;
  meetingId: string;
}

/** A no-mandate company (50,000), an expert at 700 / min, and ONE upcoming 30-minute Case booking. */
async function seedUpcomingBooking(): Promise<Seed> {
  const expertUserId = await seedUser();
  const memberId = await seedUser();

  const [company] = await wardenDb
    .insert(schema.companies)
    .values({ name: `Snapshot Co ${randomUUID()}`, isPersonal: true })
    .returning({ id: schema.companies.id });
  if (company === undefined) throw new Error('company insert failed');
  seededCompanyIds.push(company.id);

  const [expert] = await wardenDb
    .insert(schema.expertProfiles)
    .values({ userId: expertUserId, verticalId, type: 'freelancer', rateCents: EXPERT_HOURLY_700 })
    .returning({ id: schema.expertProfiles.id });
  if (expert === undefined) throw new Error('expert insert failed');
  seededExpertProfileIds.push(expert.id);

  const [wallet] = await wardenDb
    .insert(schema.creditWallets)
    .values({ companyId: company.id, balanceMinor: 50_000 })
    .returning({ id: schema.creditWallets.id });
  if (wallet === undefined) throw new Error('wallet insert failed');
  seededWalletIds.push(wallet.id);

  const [engagement] = await wardenDb
    .insert(schema.engagements)
    .values({
      engagementType: 'case',
      companyId: company.id,
      expertProfileId: expert.id,
      baloFeeBps: null,
      activatedAt: new Date(),
    })
    .returning({ id: schema.engagements.id });
  if (engagement === undefined) throw new Error('engagement insert failed');
  seededEngagementIds.push(engagement.id);

  const start = new Date(Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS + 120 * MINUTE_MS);
  const [meeting] = await wardenDb
    .insert(schema.meetings)
    .values({ scheduledStart: start, scheduledEnd: new Date(start.getTime() + 30 * MINUTE_MS) })
    .returning({ id: schema.meetings.id });
  if (meeting === undefined) throw new Error('meeting insert failed');
  seededMeetingIds.push(meeting.id);
  await wardenDb
    .insert(schema.meetingContexts)
    .values({ meetingId: meeting.id, contextType: 'case', contextId: engagement.id });

  return {
    companyId: company.id,
    walletId: wallet.id,
    memberId,
    expertProfileId: expert.id,
    engagementId: engagement.id,
    meetingId: meeting.id,
  };
}

async function deleteSeededRows(): Promise<void> {
  const userIds = seededUserIds.splice(0);
  const companyIds = seededCompanyIds.splice(0);
  const expertIds = seededExpertProfileIds.splice(0);
  const walletIds = seededWalletIds.splice(0);
  const engagementIds = seededEngagementIds.splice(0);
  const meetingIds = seededMeetingIds.splice(0);

  const sessionIds =
    walletIds.length === 0
      ? []
      : (
          await wardenDb
            .select({ id: schema.creditSessions.id })
            .from(schema.creditSessions)
            .where(inArray(schema.creditSessions.walletId, walletIds))
        ).map((row) => row.id);
  const auditWhere = [
    sessionIds.length > 0 ? inArray(schema.auditEvents.entityId, sessionIds) : undefined,
    meetingIds.length > 0 ? inArray(schema.auditEvents.entityId, meetingIds) : undefined,
    userIds.length > 0 ? inArray(schema.auditEvents.actorUserId, userIds) : undefined,
  ].filter((clause) => clause !== undefined);
  if (auditWhere.length > 0) {
    await wardenDb.delete(schema.auditEvents).where(or(...auditWhere));
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
    await wardenDb
      .delete(schema.meetingContexts)
      .where(inArray(schema.meetingContexts.meetingId, meetingIds));
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

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
    );
  }
  ({ db: aDb, client: aClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: bDb, client: bClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: wardenDb, client: wardenClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: poolDb, client: poolClient } = createConcurrentDb(url));

  const [vertical] = await wardenDb
    .select({ id: schema.verticals.id })
    .from(schema.verticals)
    .where(eq(schema.verticals.slug, 'salesforce'));
  if (vertical === undefined) {
    throw new Error('the salesforce vertical seeded by global-setup is missing');
  }
  verticalId = vertical.id;
});

beforeEach(() => {
  // AFTER the harness's own `beforeEach` (setup files run first): the module `db` now points at a
  // real, committing pool — see the module docblock.
  _setDb(poolDb);
});

afterEach(async () => {
  await deleteSeededRows();
});

afterAll(async () => {
  await deleteSeededRows().catch(() => undefined);
  await Promise.all([
    aClient?.end({ timeout: 5 }),
    bClient?.end({ timeout: 5 }),
    wardenClient?.end({ timeout: 5 }),
    poolClient?.end({ timeout: 5 }),
  ]);
});

describe('bookingFundingRepository.readSnapshot — one snapshot, across real connections', () => {
  it('a snapshot taken BEFORE another connection opens the booking’s session still reserves it and never subtracts that session’s hold', async () => {
    const seed = await seedUpcomingBooking();
    const input = {
      companyId: seed.companyId,
      expertProfileId: seed.expertProfileId,
      now: new Date(),
    };

    let firstTaken: () => void = () => undefined;
    const firstTakenSignal = new Promise<void>((resolve) => {
      firstTaken = resolve;
    });
    let releaseA: () => void = () => undefined;
    const bCommitted = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    let first: Awaited<ReturnType<typeof readSnapshotInTx>> | undefined;
    let second: Awaited<ReturnType<typeof readSnapshotInTx>> | undefined;
    const aDone = aDb.transaction(
      async (txA) => {
        first = await readSnapshotInTx(txA, input); // the snapshot is fixed here
        firstTaken();
        await bCommitted;
        second = await readSnapshotInTx(txA, input);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    );

    await firstTakenSignal;
    // Connection B — the booking's admission opens its session (hold 21,000) and COMMITS.
    const opened = await creditSessionsRepository.open(
      {
        walletId: seed.walletId,
        companyId: seed.companyId,
        expertProfileId: seed.expertProfileId,
        initiatingMemberId: seed.memberId,
        estimatedMinutes: 30,
        meetingId: seed.meetingId,
        engagementId: seed.engagementId,
        durationSource: 'presence',
      },
      bDb
    );
    expect(opened.ok).toBe(true);
    releaseA();
    await aDone;

    expect(first).toMatchObject({ kind: 'no_mandate', availableMinor: 50_000 });
    if (first?.kind !== 'no_mandate') throw new Error('expected no_mandate');
    expect(first.reservable.map((row) => row.meetingId)).toEqual([seed.meetingId]);
    // ⚠ THE PROPERTY: the same snapshot, both times — the meeting is still reserved AND its new
    // hold is not subtracted (never both, which would count 21,000 twice).
    expect(second).toEqual(first);

    // A FRESH snapshot sees B's commit: the meeting has left the reservable set and its hold is
    // inside `available` instead — counted exactly once.
    const fresh = await bookingFundingRepository.readSnapshot(input);
    expect(fresh).toMatchObject({
      kind: 'no_mandate',
      availableMinor: 50_000 - 21_000,
      reservable: [],
    });
  });
});
