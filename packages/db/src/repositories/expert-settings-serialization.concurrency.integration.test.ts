import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../schema';
import { _setDb, type Database } from '../client';
import { createConcurrentDb } from '../test/concurrent-client';
import { expertsRepository } from './experts';

/**
 * BAL-557 — THE EXPERT-SETTINGS SAVES SERIALISE WITH A STAFF EDIT ON THE PROFILE ROW LOCK, on
 * genuinely simultaneous Postgres backends.
 *
 * THE DEADLOCK THIS PREVENTS. `editApplicationAsStaff` locks the profile `FOR UPDATE`, then
 * deletes and reinserts the profile's industry / language rows. An UNLOCKED settings save deletes
 * those same child rows first (taking their row locks) and then inserts new ones — and every
 * child INSERT takes `FOR KEY SHARE` on the parent profile row for its FK check, which conflicts
 * with the staff edit's `FOR UPDATE`. Settings holds children and waits on the profile; staff
 * holds the profile and waits on the children: 40P01. `saveSettingsProfile` /
 * `saveSettingsWorkHistory` take `lockProfileRow` first, so both writers lock the profile, then
 * its children, and the later one simply queues.
 *
 * THE FORCED INTERLEAVING (case 1). A warden holds one of the profile's `expert_industries` rows
 * `FOR UPDATE`. The settings save then blocks on it mid-sync — already holding the profile lock.
 * The staff edit is issued and must block on the SETTINGS backend, on its profile lock read.
 * Releasing the warden lets both run to completion, settings first, and neither may be aborted.
 * Unlocked, the staff edit takes the profile at once, the two writers cross, and one aborts.
 *
 * DETERMINISM. Never a `sleep`-and-hope: every interleaving is observed through
 * `pg_blocking_pids` (and `pg_stat_activity.query` for WHICH statement is waiting), and an
 * exhausted poll budget throws naming what it saw.
 *
 * HARNESS RELATIONSHIP. The per-test harness transaction is unused here: rows are committed on
 * the clients below (rows written in the harness transaction are invisible to other backends)
 * and deleted by hand. The repository methods run on a chosen backend through `runOn`, which
 * rebinds the module-level `db` immediately before a call whose first statement is
 * `return db.transaction(` — the `request-domain-serialization` mechanism.
 */

type PgClient = ReturnType<typeof createConcurrentDb>['client'];

const BLOCK_POLL_INTERVAL_MS = 25;
const BLOCK_POLL_ATTEMPTS = 400;

/** The profile lock read (`lockProfileRow`): `select … from "expert_profiles" … for update`. */
const PROFILE_LOCK_READ = /^\s*select\b[\s\S]*\bfrom\s+"expert_profiles"[\s\S]*\bfor\s+update\s*$/i;

let wardenClient: PgClient;
let settingsClient: PgClient;
let staffClient: PgClient;
let observerClient: PgClient;
let wardenDb: Database;
let settingsDb: Database;
let staffDb: Database;
let observerDb: Database;
let wardenPid: number;
let settingsPid: number;
let staffPid: number;

interface Seeded {
  userIds: string[];
  profileIds: string[];
  industryIds: string[];
}
const seeded: Seeded = { userIds: [], profileIds: [], industryIds: [] };
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
  onStatement?: { pattern: RegExp; describe: string }
): Promise<void> {
  let lastSeenQuery = '(never observed blocked)';
  for (let attempt = 0; attempt < BLOCK_POLL_ATTEMPTS; attempt += 1) {
    const { blockers, query } = await blockersOf(waiterPid);
    if (blockers.includes(holderPid)) {
      lastSeenQuery = query;
      if (onStatement === undefined || onStatement.pattern.test(query)) return;
    }
    await sleep(BLOCK_POLL_INTERVAL_MS);
  }
  throw new Error(
    `backend ${waiterPid} was never observed blocked on backend ${holderPid}` +
      (onStatement === undefined ? '' : ` while running ${onStatement.describe}`) +
      ` within ${BLOCK_POLL_ATTEMPTS * BLOCK_POLL_INTERVAL_MS}ms. If it was blocked on a child-row ` +
      `delete or insert instead, the settings save no longer takes the profile lock first.\n` +
      `Last statement seen while blocked: ${lastSeenQuery}`
  );
}

/** Open a transaction on `target`, run `lock` in it, and keep it open until `release()`. */
async function holdLock(
  target: Database,
  lock: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<unknown>
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

function isDeadlock(reason: unknown): boolean {
  return (
    typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === '40P01'
  );
}

/** A committed approved expert with one industry, plus a staff actor and a second industry. */
async function seedFixture(): Promise<{
  profileId: string;
  staffUserId: string;
  industryX: string;
  industryY: string;
}> {
  const unique = randomUUID();
  const userRows = await observerDb
    .insert(schema.users)
    .values([
      {
        workosId: `settings-serial-expert-${unique}`,
        email: `settings-serial-expert-${unique}@test.example`,
        firstName: 'Settings',
        lastName: 'Expert',
      },
      {
        workosId: `settings-serial-staff-${unique}`,
        email: `settings-serial-staff-${unique}@test.example`,
        firstName: 'Settings',
        lastName: 'Staff',
        platformRole: 'admin',
      },
    ])
    .returning({ id: schema.users.id });
  const [expertUser, staffUser] = userRows;
  if (expertUser === undefined || staffUser === undefined) throw new Error('user seed failed');
  seeded.userIds.push(expertUser.id, staffUser.id);

  const [vertical] = await observerDb
    .select({ id: schema.verticals.id })
    .from(schema.verticals)
    .where(eq(schema.verticals.slug, 'salesforce'));
  if (vertical === undefined) throw new Error('salesforce vertical not seeded');

  const [profile] = await observerDb
    .insert(schema.expertProfiles)
    .values({
      userId: expertUser.id,
      verticalId: vertical.id,
      type: 'freelancer',
      applicationStatus: 'approved',
      submittedAt: new Date(),
      approvedAt: new Date(),
    })
    .returning({ id: schema.expertProfiles.id });
  if (profile === undefined) throw new Error('profile seed failed');
  seeded.profileIds.push(profile.id);

  const industryRows = await observerDb
    .insert(schema.industries)
    .values([
      { name: 'Retail', slug: `settings-serial-x-${unique}` },
      { name: 'Banking', slug: `settings-serial-y-${unique}` },
    ])
    .returning({ id: schema.industries.id });
  const [industryX, industryY] = industryRows.map((r) => r.id);
  if (industryX === undefined || industryY === undefined) throw new Error('industry seed failed');
  seeded.industryIds.push(industryX, industryY);

  await observerDb
    .insert(schema.expertIndustries)
    .values({ expertProfileId: profile.id, industryId: industryX });

  return { profileId: profile.id, staffUserId: staffUser.id, industryX, industryY };
}

async function committedIndustryIds(profileId: string): Promise<string[]> {
  const rows = await observerDb
    .select({ industryId: schema.expertIndustries.industryId })
    .from(schema.expertIndustries)
    .where(eq(schema.expertIndustries.expertProfileId, profileId));
  return rows.map((r) => r.industryId).sort((a, b) => a.localeCompare(b));
}

async function deleteSeededRows(): Promise<void> {
  const profileIds = seeded.profileIds.splice(0);
  const userIds = seeded.userIds.splice(0);
  const industryIds = seeded.industryIds.splice(0);
  if (profileIds.length > 0) {
    await observerDb
      .delete(schema.auditEvents)
      .where(inArray(schema.auditEvents.entityId, profileIds));
    await observerDb
      .delete(schema.expertIndustries)
      .where(inArray(schema.expertIndustries.expertProfileId, profileIds));
    await observerDb
      .delete(schema.expertLanguages)
      .where(inArray(schema.expertLanguages.expertProfileId, profileIds));
    await observerDb
      .delete(schema.workHistory)
      .where(inArray(schema.workHistory.expertProfileId, profileIds));
    await observerDb
      .delete(schema.expertProfiles)
      .where(inArray(schema.expertProfiles.id, profileIds));
  }
  if (industryIds.length > 0) {
    await observerDb.delete(schema.industries).where(inArray(schema.industries.id, industryIds));
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
  ({ db: settingsDb, client: settingsClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: staffDb, client: staffClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: observerDb, client: observerClient } = createConcurrentDb(url, { max: 1 }));
  wardenPid = await backendPid(wardenClient);
  settingsPid = await backendPid(settingsClient);
  staffPid = await backendPid(staffClient);
  expect(new Set([wardenPid, settingsPid, staffPid]).size).toBe(3);
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
    settingsClient?.end({ timeout: 5 }),
    staffClient?.end({ timeout: 5 }),
    observerClient?.end({ timeout: 5 }),
  ]);
});

describe('expert-settings saves vs a staff edit — the profile row lock', () => {
  it('case 1 — a settings profile save and a staff industries edit queue on the profile lock; neither deadlocks', async () => {
    const { profileId, staffUserId, industryX, industryY } = await seedFixture();

    const releaseWarden = await holdLock(wardenDb, (tx) =>
      tx
        .select({ id: schema.expertIndustries.id })
        .from(schema.expertIndustries)
        .where(
          and(
            eq(schema.expertIndustries.expertProfileId, profileId),
            eq(schema.expertIndustries.industryId, industryX)
          )
        )
        .for('update')
    );

    const settings = contend(
      runOn(settingsDb, () =>
        expertsRepository.saveSettingsProfile(profileId, {
          headline: 'Salesforce architect',
          bio: null,
          username: null,
          industryIds: [industryX, industryY],
        })
      )
    );
    await waitUntilBlockedBy(settingsPid, wardenPid);

    const staff = contend(
      runOn(staffDb, () =>
        expertsRepository.editApplicationAsStaff({
          expertProfileId: profileId,
          actorUserId: staffUserId,
          edit: { industryIds: [industryY] },
        })
      )
    );
    await waitUntilBlockedBy(staffPid, settingsPid, {
      pattern: PROFILE_LOCK_READ,
      describe: 'the profile lock read (select … from "expert_profiles" … for update)',
    });

    await releaseWarden();
    const [settingsOutcome, staffOutcome] = await Promise.allSettled([settings, staff]);

    for (const outcome of [settingsOutcome, staffOutcome]) {
      if (outcome.status === 'rejected') {
        throw new Error(
          isDeadlock(outcome.reason)
            ? 'a writer was aborted for DEADLOCK (40P01) — the settings save is not serialised on the profile lock'
            : `a writer rejected: ${String(outcome.reason)}`
        );
      }
    }
    expect(settingsOutcome).toEqual({ status: 'fulfilled', value: { outcome: 'saved' } });
    expect(staffOutcome).toMatchObject({ status: 'fulfilled', value: { outcome: 'edited' } });
    // Settings committed first; the staff edit planned against it and won last.
    expect(await committedIndustryIds(profileId)).toEqual([industryY]);
  });

  it('case 2 — a settings work-history save waits on the profile lock before touching its rows', async () => {
    const { profileId } = await seedFixture();

    const releaseWarden = await holdLock(wardenDb, (tx) =>
      tx
        .select({ id: schema.expertProfiles.id })
        .from(schema.expertProfiles)
        .where(eq(schema.expertProfiles.id, profileId))
        .for('update')
    );

    const settings = contend(
      runOn(settingsDb, () =>
        expertsRepository.saveSettingsWorkHistory(profileId, [
          {
            role: 'Salesforce Architect',
            company: 'Northwind',
            startedAt: '2022-01-01',
            isCurrent: true,
          },
        ])
      )
    );
    await waitUntilBlockedBy(settingsPid, wardenPid, {
      pattern: PROFILE_LOCK_READ,
      describe: 'the profile lock read (select … from "expert_profiles" … for update)',
    });

    await releaseWarden();
    await expect(settings).resolves.toEqual({ outcome: 'saved' });
    const rows = await observerDb
      .select({ role: schema.workHistory.role })
      .from(schema.workHistory)
      .where(eq(schema.workHistory.expertProfileId, profileId));
    expect(rows).toEqual([{ role: 'Salesforce Architect' }]);
  });

  it('case 3 — both settings saves report not_found for an unknown profile', async () => {
    const unknown = randomUUID();

    await expect(
      runOn(settingsDb, () =>
        expertsRepository.saveSettingsProfile(unknown, {
          headline: null,
          bio: null,
          username: null,
        })
      )
    ).resolves.toEqual({ outcome: 'not_found' });
    await expect(
      runOn(settingsDb, () => expertsRepository.saveSettingsWorkHistory(unknown, []))
    ).resolves.toEqual({ outcome: 'not_found' });
  });
});
