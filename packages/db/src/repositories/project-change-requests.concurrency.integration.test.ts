import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import * as schema from '../schema';
import { _setDb, type Database } from '../client';
import { createConcurrentDb } from '../test/concurrent-client';
import {
  projectEngagementsRepository,
  ChangeRequestMilestoneMismatchError,
} from './project-engagements';
import {
  engagementMilestonesRepository,
  InvalidMilestoneTransitionError,
} from './engagement-milestones';

/**
 * BAL-621 — A CHANGE-REQUEST ROUND SERIALISES WITH MILESTONE TRANSITIONS ON THE ENGAGEMENT
 * LOCK, on genuinely simultaneous Postgres backends.
 *
 * `requestChanges` flips a `pending_acceptance` project back to `active` and reopens the
 * tagged milestones in one transaction. Every milestone transition locks the parent
 * `engagements` row FOR UPDATE first, then the milestone. So does the round: engagement →
 * child → tagged milestones (FOR UPDATE, id order). Three properties follow, one per case:
 *
 *   1. The round queues on the engagement lock BEFORE it touches any milestone row, then
 *      reopens the tagged milestone once the lock is free.
 *   2. A milestone revert queued behind the round runs after it and sees the reopened row
 *      — it fails as an illegal `in_progress → in_progress` move instead of racing it.
 *   3. The round reads its tagged milestones only UNDER the engagement lock, so it sees
 *      whatever the previous lock-holder committed. Through today's API nothing can
 *      change a milestone of a `pending_acceptance` project; the warden writes the
 *      removal directly so the snapshot the round planned against is observable.
 *
 * ⚠ MUTATION PROOFS (recorded in the PR): (a) lock the tagged rows FOR UPDATE before
 * `advanceProjectDelivery` → case 1's NOWAIT probe and case 3's wait both fail; (b) read
 * the tagged rows before `advanceProjectDelivery` WITHOUT a lock → case 3 resolves
 * instead of rejecting; (c) make `revert` lock the milestone before the engagement → case
 * 2 deadlocks (40P01).
 *
 * DETERMINISM. Never a `sleep`-and-hope: every interleaving is observed through
 * `pg_blocking_pids` (and `pg_stat_activity.query` for WHICH statement is waiting), and an
 * exhausted poll budget throws naming what it saw.
 *
 * HARNESS RELATIONSHIP. The per-test harness transaction is unused here: rows are
 * committed on the clients below (rows written in the harness transaction are invisible
 * to other backends) and deleted by hand. The repository methods run on a chosen backend
 * through `runOn`, which rebinds the module-level `db` immediately before a call whose
 * first statement is `return db.transaction(` — the `request-domain-serialization`
 * mechanism.
 */

type PgClient = ReturnType<typeof createConcurrentDb>['client'];
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

// Bare name so the audit-trail ordering invariant reads `asc(auditEvents.createdAt)` here.
const { auditEvents } = schema;

const BLOCK_POLL_INTERVAL_MS = 25;
const BLOCK_POLL_ATTEMPTS = 400;
const KEY_PREFIX = 'change-round-concurrency-';

/** The engagement lock read (`lockEngagementRowTx` / `lockActiveEngagement`). */
const ENGAGEMENT_LOCK_READ = /^\s*select\b[\s\S]*\bfrom\s+"engagements"[\s\S]*\bfor\s+update\s*$/i;
const ON_ENGAGEMENT_LOCK = {
  pattern: ENGAGEMENT_LOCK_READ,
  describe: 'the engagement lock read (select … from "engagements" … for update)',
};

let wardenClient: PgClient;
let requesterClient: PgClient;
let reverterClient: PgClient;
let observerClient: PgClient;
let wardenDb: Database;
let requesterDb: Database;
let reverterDb: Database;
let observerDb: Database;
let wardenPid: number;
let requesterPid: number;
let reverterPid: number;
let verticalId: string;

interface Seeded {
  userIds: string[];
  companyIds: string[];
  expertProfileIds: string[];
  engagementIds: string[];
  milestoneIds: string[];
}
const seeded: Seeded = {
  userIds: [],
  companyIds: [],
  expertProfileIds: [],
  engagementIds: [],
  milestoneIds: [],
};
const openHolds: Array<() => Promise<void>> = [];
const inFlight: Array<Promise<unknown>> = [];

function contend<T>(statement: Promise<T>): Promise<T> {
  inFlight.push(statement.catch(() => undefined));
  return statement;
}

function runOn<T>(target: Database, call: () => Promise<T>): Promise<T> {
  _setDb(target);
  return call();
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function backendPid(client: PgClient): Promise<number> {
  const rows = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const [row] = rows;
  if (row === undefined) throw new Error('pg_backend_pid() returned no row');
  return row.pid;
}

async function blockersOf(waiterPid: number): Promise<{ blockers: number[]; query: string }> {
  const rows = await observerClient<{ blockers: number[]; query: string }[]>`
    select coalesce(pg_blocking_pids(${waiterPid}::int), '{}'::int[]) as blockers,
           coalesce((select query from pg_stat_activity where pid = ${waiterPid}::int), '') as query
  `;
  const [row] = rows;
  return row ?? { blockers: [], query: '' };
}

async function waitUntilBlockedBy(
  waiterPid: number,
  holderPid: number,
  onStatement: { pattern: RegExp; describe: string }
): Promise<void> {
  let lastSeenQuery = '(never observed blocked)';
  for (let attempt = 0; attempt < BLOCK_POLL_ATTEMPTS; attempt += 1) {
    const { blockers, query } = await blockersOf(waiterPid);
    if (blockers.includes(holderPid)) {
      lastSeenQuery = query;
      if (onStatement.pattern.test(query)) return;
    }
    await sleep(BLOCK_POLL_INTERVAL_MS);
  }
  throw new Error(
    `backend ${waiterPid} was never observed blocked on backend ${holderPid} while running ` +
      `${onStatement.describe} within ${BLOCK_POLL_ATTEMPTS * BLOCK_POLL_INTERVAL_MS}ms.\n` +
      `Last statement seen while blocked: ${lastSeenQuery}`
  );
}

/** Open a transaction on `target`, run `lock` in it, and keep it open until `release()`. */
async function holdLock(
  target: Database,
  lock: (tx: Tx) => Promise<unknown>
): Promise<() => Promise<void>> {
  let release: (() => void) | undefined;
  let locked: (() => void) | undefined;
  let failed: ((reason: unknown) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    locked = resolve;
    failed = reject;
  });
  const settled = target
    .transaction(async (tx) => {
      await lock(tx);
      locked?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    })
    .catch((error: unknown) => {
      failed?.(error);
    });
  await ready;
  const commit = async (): Promise<void> => {
    release?.();
    await settled;
  };
  openHolds.push(commit);
  return commit;
}

function lockEngagement(tx: Tx, engagementId: string): Promise<unknown> {
  return tx
    .select({ id: schema.engagements.id })
    .from(schema.engagements)
    .where(eq(schema.engagements.id, engagementId))
    .for('update');
}

/**
 * Assert no other backend holds `milestoneId`'s row lock: an autocommit
 * `FOR UPDATE NOWAIT` takes it and releases it at statement end, or raises 55P03.
 */
async function expectMilestoneRowUnlocked(milestoneId: string): Promise<void> {
  try {
    await observerClient`
      select id from engagement_milestones where id = ${milestoneId}::uuid for update nowait
    `;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === '55P03') {
      throw new Error(
        `milestone ${milestoneId} is row-locked while the round still waits on the engagement — ` +
          'the round took a milestone lock before the engagement lock'
      );
    }
    throw error;
  }
}

async function seedUser(label: string): Promise<string> {
  const unique = randomUUID();
  const [row] = await observerDb
    .insert(schema.users)
    .values({
      workosId: `${KEY_PREFIX}${unique}`,
      email: `${KEY_PREFIX}${unique}@test.example`,
      firstName: label,
      lastName: 'Concurrency',
    })
    .returning({ id: schema.users.id });
  if (row === undefined) throw new Error('user insert failed');
  seeded.userIds.push(row.id);
  return row.id;
}

/**
 * A committed `pending_acceptance` project (parent `active`, child `pending_acceptance`, as
 * `requestCompletion` leaves it) with two COMPLETED milestones.
 */
async function seedPendingProject(): Promise<{
  engagementId: string;
  clientUserId: string;
  expertUserId: string;
  discoveryId: string;
  buildId: string;
}> {
  const expertUserId = await seedUser('Expert');
  const clientUserId = await seedUser('Client');

  const [company] = await observerDb
    .insert(schema.companies)
    .values({ name: `${KEY_PREFIX}${randomUUID()}`, isPersonal: true })
    .returning({ id: schema.companies.id });
  if (company === undefined) throw new Error('company insert failed');
  seeded.companyIds.push(company.id);

  const [expert] = await observerDb
    .insert(schema.expertProfiles)
    .values({ userId: expertUserId, verticalId, type: 'freelancer' })
    .returning({ id: schema.expertProfiles.id });
  if (expert === undefined) throw new Error('expert insert failed');
  seeded.expertProfileIds.push(expert.id);

  const [engagement] = await observerDb
    .insert(schema.engagements)
    .values({
      engagementType: 'project',
      companyId: company.id,
      expertProfileId: expert.id,
      status: 'active',
      activatedAt: new Date(),
    })
    .returning({ id: schema.engagements.id });
  if (engagement === undefined) throw new Error('engagement insert failed');
  seeded.engagementIds.push(engagement.id);

  await observerDb.insert(schema.projectEngagements).values({
    engagementId: engagement.id,
    deliveryStatus: 'pending_acceptance',
    pricingMethod: 'fixed',
    priceCents: 500_000,
    completionRequestedByUserId: expertUserId,
    completionRequestedAt: new Date(),
  });

  const milestones = await observerDb
    .insert(schema.engagementMilestones)
    .values(
      ['Discovery', 'Build'].map((title, sortOrder) => ({
        engagementId: engagement.id,
        sortOrder,
        title,
        status: 'completed' as const,
        completedByUserId: expertUserId,
        completedAt: new Date(),
        createdByUserId: expertUserId,
      }))
    )
    .returning({ id: schema.engagementMilestones.id, title: schema.engagementMilestones.title });
  const discoveryId = milestones.find((m) => m.title === 'Discovery')?.id;
  const buildId = milestones.find((m) => m.title === 'Build')?.id;
  if (discoveryId === undefined || buildId === undefined) {
    throw new Error('milestone insert failed');
  }
  seeded.milestoneIds.push(discoveryId, buildId);

  return { engagementId: engagement.id, clientUserId, expertUserId, discoveryId, buildId };
}

async function committedMilestoneStatus(milestoneId: string): Promise<string | undefined> {
  const [row] = await observerDb
    .select({ status: schema.engagementMilestones.status })
    .from(schema.engagementMilestones)
    .where(eq(schema.engagementMilestones.id, milestoneId));
  return row?.status;
}

async function committedRoundIds(engagementId: string): Promise<string[]> {
  const rows = await observerDb
    .select({ id: schema.projectChangeRequests.id })
    .from(schema.projectChangeRequests)
    .where(eq(schema.projectChangeRequests.engagementId, engagementId));
  return rows.map((row) => row.id);
}

async function committedDeliveryStatus(engagementId: string): Promise<string | undefined> {
  const [row] = await observerDb
    .select({ status: schema.projectEngagements.deliveryStatus })
    .from(schema.projectEngagements)
    .where(eq(schema.projectEngagements.engagementId, engagementId));
  return row?.status;
}

async function committedRevertAudits(
  milestoneId: string
): Promise<Array<{ metadata: unknown; actorUserId: string | null }>> {
  return observerDb
    .select({
      metadata: auditEvents.metadata,
      actorUserId: auditEvents.actorUserId,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityId, milestoneId),
        eq(auditEvents.action, 'engagement_milestone.reverted')
      )
    )
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.seq));
}

async function deleteSeededRows(): Promise<void> {
  const userIds = seeded.userIds.splice(0);
  const companyIds = seeded.companyIds.splice(0);
  const expertProfileIds = seeded.expertProfileIds.splice(0);
  const engagementIds = seeded.engagementIds.splice(0);
  const milestoneIds = seeded.milestoneIds.splice(0);

  const auditWhere = [
    engagementIds.length > 0 ? inArray(auditEvents.entityId, engagementIds) : undefined,
    milestoneIds.length > 0 ? inArray(auditEvents.entityId, milestoneIds) : undefined,
    userIds.length > 0 ? inArray(auditEvents.actorUserId, userIds) : undefined,
  ].filter((clause) => clause !== undefined);
  if (auditWhere.length > 0) {
    await observerDb.delete(auditEvents).where(or(...auditWhere));
  }
  // CASCADES the project child, the milestones, the rounds and their tag rows.
  if (engagementIds.length > 0) {
    await observerDb
      .delete(schema.engagements)
      .where(inArray(schema.engagements.id, engagementIds));
  }
  if (expertProfileIds.length > 0) {
    await observerDb
      .delete(schema.expertProfiles)
      .where(inArray(schema.expertProfiles.id, expertProfileIds));
  }
  if (companyIds.length > 0) {
    await observerDb.delete(schema.companies).where(inArray(schema.companies.id, companyIds));
  }
  if (userIds.length > 0) {
    await observerDb.delete(schema.users).where(inArray(schema.users.id, userIds));
  }
}

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
    );
  }
  ({ db: wardenDb, client: wardenClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: requesterDb, client: requesterClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: reverterDb, client: reverterClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: observerDb, client: observerClient } = createConcurrentDb(url, { max: 1 }));
  wardenPid = await backendPid(wardenClient);
  requesterPid = await backendPid(requesterClient);
  reverterPid = await backendPid(reverterClient);
  expect(new Set([wardenPid, requesterPid, reverterPid]).size).toBe(3);

  const [vertical] = await observerDb
    .select({ id: schema.verticals.id })
    .from(schema.verticals)
    .where(eq(schema.verticals.slug, 'salesforce'));
  if (vertical === undefined)
    throw new Error('the salesforce vertical seeded by global-setup is missing');
  verticalId = vertical.id;
});

afterEach(async () => {
  // Release held locks, let contenders finish, then delete — in that order.
  for (const commit of openHolds.splice(0)) {
    await commit().catch(() => undefined);
  }
  await Promise.allSettled(inFlight.splice(0));
  await deleteSeededRows().catch(() => undefined);
});

afterAll(async () => {
  await deleteSeededRows().catch(() => undefined);
  await Promise.all([
    wardenClient?.end({ timeout: 5 }),
    requesterClient?.end({ timeout: 5 }),
    reverterClient?.end({ timeout: 5 }),
    observerClient?.end({ timeout: 5 }),
  ]);
});

describe('requestChanges vs milestone transitions — the engagement lock', () => {
  it('case 1 — the round queues on the engagement lock before locking any milestone, then reopens the tagged one', async () => {
    const seed = await seedPendingProject();

    const releaseWarden = await holdLock(wardenDb, (tx) => lockEngagement(tx, seed.engagementId));

    const round = contend(
      runOn(requesterDb, () =>
        projectEngagementsRepository.requestChanges({
          engagementId: seed.engagementId,
          userId: seed.clientUserId,
          note: 'The discovery write-up needs another pass.',
          milestoneIds: [seed.discoveryId],
        })
      )
    );
    await waitUntilBlockedBy(requesterPid, wardenPid, ON_ENGAGEMENT_LOCK);
    // Lock order engagement → milestones: while it queues, the round holds no milestone lock.
    await expectMilestoneRowUnlocked(seed.discoveryId);

    await releaseWarden();
    const result = await round;

    expect(result.status).toBe('active');
    expect(result.changeRequest).toMatchObject({
      roundNumber: 1,
      taggedMilestones: [{ id: seed.discoveryId, title: 'Discovery' }],
      revertedMilestoneIds: [seed.discoveryId],
    });
    expect(await committedRoundIds(seed.engagementId)).toEqual([result.changeRequest.id]);
    expect(await committedMilestoneStatus(seed.discoveryId)).toBe('in_progress');
    expect(await committedMilestoneStatus(seed.buildId)).toBe('completed');
  });

  it('case 2 — a milestone revert queued behind the round runs after it, sees the reopened row and is rejected', async () => {
    const seed = await seedPendingProject();

    const releaseWarden = await holdLock(wardenDb, (tx) => lockEngagement(tx, seed.engagementId));

    const round = contend(
      runOn(requesterDb, () =>
        projectEngagementsRepository.requestChanges({
          engagementId: seed.engagementId,
          userId: seed.clientUserId,
          note: 'Discovery is missing the integration map.',
          milestoneIds: [seed.discoveryId],
        })
      )
    );
    await waitUntilBlockedBy(requesterPid, wardenPid, ON_ENGAGEMENT_LOCK);

    const revert = contend(
      runOn(reverterDb, () =>
        engagementMilestonesRepository.revert({
          milestoneId: seed.discoveryId,
          userId: seed.expertUserId,
        })
      )
    );
    // Queued BEHIND the round on the same engagement row, not beside it.
    await waitUntilBlockedBy(reverterPid, requesterPid, ON_ENGAGEMENT_LOCK);

    await releaseWarden();
    const [roundOutcome, revertOutcome] = await Promise.allSettled([round, revert]);

    if (roundOutcome.status === 'rejected') {
      throw new Error(`the round rejected: ${String(roundOutcome.reason)}`);
    }
    expect(revertOutcome).toMatchObject({
      status: 'rejected',
      reason: expect.any(InvalidMilestoneTransitionError),
    });
    expect(revertOutcome).toMatchObject({ reason: { from: 'in_progress', to: 'in_progress' } });

    expect(await committedMilestoneStatus(seed.discoveryId)).toBe('in_progress');
    // Exactly one revert happened, and it was the round's.
    const reverts = await committedRevertAudits(seed.discoveryId);
    expect(reverts).toHaveLength(1);
    expect(reverts[0]).toMatchObject({
      actorUserId: seed.clientUserId,
      metadata: { change_request_id: roundOutcome.value.changeRequest.id },
    });
  });

  it('case 3 — the round reads its tagged milestones under the engagement lock and sees the lock-holder’s committed removal', async () => {
    const seed = await seedPendingProject();

    const releaseWarden = await holdLock(wardenDb, async (tx) => {
      await lockEngagement(tx, seed.engagementId);
      await tx
        .update(schema.engagementMilestones)
        .set({ deletedAt: new Date() })
        .where(eq(schema.engagementMilestones.id, seed.discoveryId));
    });

    const round = contend(
      runOn(requesterDb, () =>
        projectEngagementsRepository.requestChanges({
          engagementId: seed.engagementId,
          userId: seed.clientUserId,
          note: 'Discovery again, please.',
          milestoneIds: [seed.discoveryId],
        })
      )
    );
    await waitUntilBlockedBy(requesterPid, wardenPid, ON_ENGAGEMENT_LOCK);

    await releaseWarden();
    await expect(round).rejects.toBeInstanceOf(ChangeRequestMilestoneMismatchError);

    // The whole round rolled back.
    expect(await committedDeliveryStatus(seed.engagementId)).toBe('pending_acceptance');
    expect(await committedRoundIds(seed.engagementId)).toEqual([]);
    expect(await committedRevertAudits(seed.discoveryId)).toEqual([]);
    expect(await committedMilestoneStatus(seed.discoveryId)).toBe('completed');
  });
});
