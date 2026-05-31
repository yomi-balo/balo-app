/**
 * Scoped HARD deletes for the BAL-239 seeder.
 *
 * Never uses `TRUNCATE … CASCADE` — that would wipe real dev users too. Seed
 * rows are identified strictly by their email domain / workos id prefix, so
 * non-seed dev users are never touched.
 *
 * Runs INSIDE the orchestrator's transaction (receives the tx handle). The
 * admin `db` client bypasses RLS, so no `app.current_user_id` setup is needed.
 */
import {
  users,
  expertProfiles,
  expertSkills,
  expertCertifications,
  expertLanguages,
  expertIndustries,
  workHistory,
  availabilityRules,
  availabilityCache,
  consultations,
  calendarConnections,
  calendarSubCalendars,
  and,
  inArray,
  like,
} from '@balo/db';
import type { Database } from '@balo/db';
import { SEED_EMAIL_DOMAIN, SEED_WORKOS_PREFIX } from './constants.js';

/** Drizzle transaction handle (same surface as the db client for our needs). */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type TruncateScope = 'experts' | 'availability';

export interface TruncateResult {
  seedUserCount: number;
  seedProfileCount: number;
}

/** Resolve the seed user + profile ids in scope. */
async function resolveSeedIds(tx: Tx): Promise<{ userIds: string[]; profileIds: string[] }> {
  // Require BOTH seed markers (logical AND), not either-or. The seeder ALWAYS
  // sets both `email LIKE '%@seed.balo.dev'` AND `workos_id LIKE 'seed_%'`, so a
  // genuine seed row always matches both. Demanding both means a real dev user
  // who happens to match ONE marker (e.g. a personal address at seed.balo.dev,
  // or a workos id that starts with `seed_`) can never be swept into a
  // destructive delete here. Even if a partial match somehow slipped through,
  // the delete fails closed: a real signup user has a `company_members` row
  // whose FK to `users` is ON DELETE NO ACTION/RESTRICT, so deleting that user
  // would raise a FK violation and roll the whole transaction back rather than
  // corrupt data.
  const seedUsers = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        like(users.email, `%@${SEED_EMAIL_DOMAIN}`),
        like(users.workosId, `${SEED_WORKOS_PREFIX}%`)
      )
    );
  const userIds = seedUsers.map((u) => u.id);
  if (userIds.length === 0) return { userIds: [], profileIds: [] };

  const seedProfiles = await tx
    .select({ id: expertProfiles.id })
    .from(expertProfiles)
    .where(inArray(expertProfiles.userId, userIds));

  return { userIds, profileIds: seedProfiles.map((p) => p.id) };
}

/** Delete every child row that references the given expert profile ids. */
async function deleteProfileChildren(tx: Tx, profileIds: string[]): Promise<void> {
  if (profileIds.length === 0) return;

  // Calendar sub-calendars hang off connections, not profiles — delete them
  // first (defensive; no calendars are seeded today).
  const conns = await tx
    .select({ id: calendarConnections.id })
    .from(calendarConnections)
    .where(inArray(calendarConnections.expertProfileId, profileIds));
  const connIds = conns.map((c) => c.id);
  if (connIds.length > 0) {
    await tx
      .delete(calendarSubCalendars)
      .where(inArray(calendarSubCalendars.connectionId, connIds));
  }

  await tx.delete(availabilityCache).where(inArray(availabilityCache.expertProfileId, profileIds));
  await tx.delete(consultations).where(inArray(consultations.expertProfileId, profileIds));
  await tx.delete(availabilityRules).where(inArray(availabilityRules.expertProfileId, profileIds));
  await tx
    .delete(calendarConnections)
    .where(inArray(calendarConnections.expertProfileId, profileIds));
  await tx.delete(expertSkills).where(inArray(expertSkills.expertProfileId, profileIds));
  await tx.delete(expertLanguages).where(inArray(expertLanguages.expertProfileId, profileIds));
  await tx.delete(expertIndustries).where(inArray(expertIndustries.expertProfileId, profileIds));
  await tx
    .delete(expertCertifications)
    .where(inArray(expertCertifications.expertProfileId, profileIds));
  await tx.delete(workHistory).where(inArray(workHistory.expertProfileId, profileIds));
}

/**
 * Scoped hard-delete of seed data.
 *
 * - `'experts'`: full destructive regenerate — deletes all profile children,
 *   the profiles, and the seed users themselves (FK-safe order).
 * - `'availability'`: refresh-only — deletes availability_cache, consultations,
 *   and availability_rules for seed profiles; leaves experts/users intact.
 */
export async function truncateSeedData(tx: Tx, scope: TruncateScope): Promise<TruncateResult> {
  const { userIds, profileIds } = await resolveSeedIds(tx);

  if (scope === 'availability') {
    if (profileIds.length > 0) {
      await tx
        .delete(availabilityCache)
        .where(inArray(availabilityCache.expertProfileId, profileIds));
      await tx.delete(consultations).where(inArray(consultations.expertProfileId, profileIds));
      await tx
        .delete(availabilityRules)
        .where(inArray(availabilityRules.expertProfileId, profileIds));
    }
    return { seedUserCount: userIds.length, seedProfileCount: profileIds.length };
  }

  // scope === 'experts'
  await deleteProfileChildren(tx, profileIds);
  if (profileIds.length > 0) {
    await tx.delete(expertProfiles).where(inArray(expertProfiles.id, profileIds));
  }
  if (userIds.length > 0) {
    await tx.delete(users).where(inArray(users.id, userIds));
  }

  return { seedUserCount: userIds.length, seedProfileCount: profileIds.length };
}
