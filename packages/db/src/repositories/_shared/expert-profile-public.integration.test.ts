import { describe, it, expect } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { userRowIsLive } from '@balo/shared/authz';
import { db } from '../../client';
import { expertProfiles, users } from '../../schema';
import { expertDraftFactory, userFactory } from '../../test/factories';
import { expertProfileIsPublic, publicProfileUsernameSql } from './expert-profile-public';

/**
 * `expertProfileIsPublic` must be TRUE exactly when `searchable` AND `approved_at IS NOT NULL`
 * AND the owner is live (`userRowIsLive`). Every combination of the three inputs is evaluated
 * by Postgres and compared with that rule evaluated in JS over the same stored row, so a term
 * dropped from or added to the fragment fails here.
 */
const SEARCHABLE = [true, false] as const;
const APPROVED_AT = [new Date('2026-01-01T00:00:00.000Z'), null] as const;
const OWNERS = [
  { status: 'active', deletedAt: null },
  { status: 'suspended', deletedAt: null },
  { status: 'inactive', deletedAt: null },
  { status: 'active', deletedAt: new Date('2026-02-01T00:00:00.000Z') },
] as const;
const COMBOS = SEARCHABLE.flatMap((searchable) =>
  APPROVED_AT.flatMap((approvedAt) => OWNERS.map((owner) => ({ searchable, approvedAt, owner })))
);

async function seedProfile(input: (typeof COMBOS)[number]): Promise<string> {
  const user = await userFactory();
  const draft = await expertDraftFactory({ userId: user.id });
  await db
    .update(expertProfiles)
    .set({
      searchable: input.searchable,
      approvedAt: input.approvedAt,
      username: `public-fragment-${draft.id}`,
    })
    .where(eq(expertProfiles.id, draft.id));
  await db
    .update(users)
    .set({ status: input.owner.status, deletedAt: input.owner.deletedAt })
    .where(eq(users.id, user.id));
  return draft.id;
}

async function readFragments(
  expertProfileId: string
): Promise<{ isPublic: boolean; username: string | null; expected: boolean } | undefined> {
  const [row] = await db
    .select({
      isPublic: sql<boolean>`${expertProfileIsPublic}`,
      username: publicProfileUsernameSql,
      rawUsername: expertProfiles.username,
      searchable: expertProfiles.searchable,
      approvedAt: expertProfiles.approvedAt,
      status: users.status,
      deletedAt: users.deletedAt,
    })
    .from(expertProfiles)
    .innerJoin(users, eq(users.id, expertProfiles.userId))
    .where(eq(expertProfiles.id, expertProfileId));
  if (row === undefined) return undefined;
  const expected =
    row.searchable &&
    row.approvedAt !== null &&
    userRowIsLive({ status: row.status, deletedAt: row.deletedAt });
  return { isPublic: row.isPublic, username: row.username, expected };
}

describe('expertProfileIsPublic — searchable AND approved AND a live owner', () => {
  it('covers every combination, with both outcomes represented', () => {
    expect(COMBOS).toHaveLength(16);
    const publicCombos = COMBOS.filter(
      (c) => c.searchable && c.approvedAt !== null && userRowIsLive(c.owner)
    );
    expect(publicCombos).toHaveLength(1);
  });

  it.each(COMBOS)(
    'searchable=$searchable approvedAt=$approvedAt owner=$owner.status/$owner.deletedAt',
    async (combo) => {
      const id = await seedProfile(combo);

      const row = await readFragments(id);

      expect(row).toBeDefined();
      if (row === undefined) return;
      expect(row.isPublic).toBe(row.expected);
      // The gated username follows the predicate exactly.
      expect(row.username).toBe(row.expected ? `public-fragment-${id}` : null);
    }
  );

  it('filters as a WHERE term in a core select', async () => {
    const visible = await seedProfile({
      searchable: true,
      approvedAt: new Date('2026-01-01T00:00:00.000Z'),
      owner: { status: 'active', deletedAt: null },
    });
    const hidden = await seedProfile({
      searchable: false,
      approvedAt: new Date('2026-01-01T00:00:00.000Z'),
      owner: { status: 'active', deletedAt: null },
    });

    const rows = await db
      .select({ id: expertProfiles.id })
      .from(expertProfiles)
      .where(and(inArray(expertProfiles.id, [visible, hidden]), expertProfileIsPublic));

    expect(rows).toEqual([{ id: visible }]);
  });

  it('renders under the relational query builder alias', async () => {
    const visible = await seedProfile({
      searchable: true,
      approvedAt: new Date('2026-01-01T00:00:00.000Z'),
      owner: { status: 'active', deletedAt: null },
    });

    const row = await db.query.expertProfiles.findFirst({
      where: and(eq(expertProfiles.id, visible), expertProfileIsPublic),
      columns: { id: true },
      extras: { username: publicProfileUsernameSql.as('public_username') },
    });

    expect(row).toEqual({ id: visible, username: `public-fragment-${visible}` });
  });

  it("is keyed on the profile's OWN owner, not any live user", async () => {
    await seedProfile({
      searchable: true,
      approvedAt: new Date('2026-01-01T00:00:00.000Z'),
      owner: { status: 'active', deletedAt: null },
    });
    const suspended = await seedProfile({
      searchable: true,
      approvedAt: new Date('2026-01-01T00:00:00.000Z'),
      owner: { status: 'suspended', deletedAt: null },
    });

    const row = await readFragments(suspended);

    expect(row?.isPublic).toBe(false);
    expect(row?.username).toBeNull();
  });
});
