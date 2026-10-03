import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { userRowIsLive } from '@balo/shared/authz';
import { db } from '../../client';
import { expertProfiles, users } from '../../schema';
import { expertDraftFactory, userFactory } from '../../test/factories';
import { expertOwnerIsLive } from './expert-owner-live';

/**
 * `expertOwnerIsLive` is the SQL twin of `userRowIsLive`. For every `users.status` ×
 * `deleted_at` combination, the fragment evaluated by Postgres must agree with the function
 * evaluated in JS over the same row. A change to either definition fails here.
 */
const STATUSES = ['active', 'inactive', 'suspended'] as const;
const DELETED = [null, new Date('2026-01-01T00:00:00.000Z')] as const;
const COMBOS = STATUSES.flatMap((status) => DELETED.map((deletedAt) => ({ status, deletedAt })));

async function sqlSaysLive(expertProfileId: string): Promise<boolean | undefined> {
  const [row] = await db
    .select({ live: sql<boolean>`${expertOwnerIsLive}` })
    .from(expertProfiles)
    .where(eq(expertProfiles.id, expertProfileId));
  return row?.live;
}

describe('expertOwnerIsLive — parity with userRowIsLive', () => {
  it('covers every status × deleted_at combination, with both outcomes represented', () => {
    expect(COMBOS).toHaveLength(6);
    expect(COMBOS.filter((c) => userRowIsLive(c))).toHaveLength(1);
  });

  it.each(COMBOS)(
    'status=$status deletedAt=$deletedAt: SQL agrees with userRowIsLive',
    async ({ status, deletedAt }) => {
      const user = await userFactory();
      const draft = await expertDraftFactory({ userId: user.id });
      await db.update(users).set({ status, deletedAt }).where(eq(users.id, user.id));

      const [stored] = await db
        .select({ status: users.status, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, user.id));
      expect(stored).toBeDefined();
      if (stored === undefined) return;

      expect(await sqlSaysLive(draft.id)).toBe(userRowIsLive(stored));
    }
  );

  it("is keyed on the profile's OWN owner, not any live user", async () => {
    const liveUser = await userFactory();
    await expertDraftFactory({ userId: liveUser.id });
    const suspendedUser = await userFactory();
    const suspendedDraft = await expertDraftFactory({ userId: suspendedUser.id });
    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, suspendedUser.id));

    expect(await sqlSaysLive(suspendedDraft.id)).toBe(false);
  });
});
