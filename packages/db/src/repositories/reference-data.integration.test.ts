import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import {
  verticals,
  categories,
  products,
  productAliases,
  supportTypes,
  projectTagGroups,
  projectTags,
  type ProductAliasKind,
} from '../schema';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { referenceDataRepository } from './reference-data';

// Inline-seeding helpers. The integration global-setup seeds ONLY the Salesforce
// vertical, so each test creates its own taxonomy rows (transaction-rolled-back
// per test). Unique slugs avoid collisions across the shared vertical.
let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Date.now()}`;
}

async function createVertical(): Promise<{ id: string; slug: string }> {
  const slug = uniq('vertical');
  const [row] = await db
    .insert(verticals)
    .values({ name: uniq('Vertical'), slug, isActive: true })
    .returning();
  return { id: row!.id, slug };
}

async function createSupportType(
  verticalId: string,
  name: string,
  opts: { isActive?: boolean; sortOrder?: number } = {}
): Promise<string> {
  const [row] = await db
    .insert(supportTypes)
    .values({
      verticalId,
      name,
      slug: uniq('st'),
      isActive: opts.isActive ?? true,
      sortOrder: opts.sortOrder ?? 0,
    })
    .returning();
  return row!.id;
}

async function createProjectTagGroup(
  verticalId: string,
  name: string,
  opts: { isActive?: boolean; sortOrder?: number; deletedAt?: Date | null } = {}
): Promise<string> {
  const [row] = await db
    .insert(projectTagGroups)
    .values({
      verticalId,
      name,
      slug: uniq('grp'),
      isActive: opts.isActive ?? true,
      sortOrder: opts.sortOrder ?? 0,
      deletedAt: opts.deletedAt ?? null,
    })
    .returning();
  return row!.id;
}

async function createProjectTag(
  verticalId: string,
  groupId: string,
  name: string,
  opts: { isActive?: boolean; sortOrder?: number; deletedAt?: Date | null } = {}
): Promise<string> {
  const [row] = await db
    .insert(projectTags)
    .values({
      verticalId,
      groupId,
      name,
      slug: uniq('tag'),
      isActive: opts.isActive ?? true,
      sortOrder: opts.sortOrder ?? 0,
      deletedAt: opts.deletedAt ?? null,
    })
    .returning();
  return row!.id;
}

// ── getVerticalBySlug ──────────────────────────────────────────────────────

describe('referenceDataRepository.getVerticalBySlug', () => {
  it('returns the vertical matching the slug', async () => {
    const created = await createVertical();
    const found = await referenceDataRepository.getVerticalBySlug(created.slug);
    expect(found?.id).toBe(created.id);
    expect(found?.slug).toBe(created.slug);
  });

  it('returns undefined for an unknown slug', async () => {
    const found = await referenceDataRepository.getVerticalBySlug(uniq('nope'));
    expect(found).toBeUndefined();
  });

  it('resolves the seeded salesforce vertical', async () => {
    const found = await referenceDataRepository.getVerticalBySlug('salesforce');
    expect(found?.slug).toBe('salesforce');
  });
});

// ── getSupportTypes(verticalId) — vertical isolation ────────────────────────

describe('referenceDataRepository.getSupportTypes', () => {
  it('returns ONLY the requesting vertical’s active support types, sorted', async () => {
    const a = await createVertical();
    const b = await createVertical();

    // Vertical A: two active (out of order) + one inactive.
    const a1 = await createSupportType(a.id, 'A-Second', { sortOrder: 1 });
    const a0 = await createSupportType(a.id, 'A-First', { sortOrder: 0 });
    await createSupportType(a.id, 'A-Inactive', { isActive: false, sortOrder: 2 });

    // Vertical B: a support type that must NOT appear in A's results.
    const b0 = await createSupportType(b.id, 'B-Only', { sortOrder: 0 });

    const aTypes = await referenceDataRepository.getSupportTypes(a.id);
    const aIds = aTypes.map((t) => t.id);

    // Isolation: only A's ACTIVE types, none of B's, no inactive.
    expect(aIds).toEqual([a0, a1]); // ordered by sortOrder asc
    expect(aIds).not.toContain(b0);
    expect(aTypes.every((t) => t.verticalId === a.id)).toBe(true);
    expect(aTypes.every((t) => t.isActive)).toBe(true);

    // Vertical B sees only its own.
    const bTypes = await referenceDataRepository.getSupportTypes(b.id);
    expect(bTypes.map((t) => t.id)).toEqual([b0]);
  });

  it('allows the SAME slug across two verticals (composite-unique, not global)', async () => {
    const a = await createVertical();
    const b = await createVertical();

    const sharedSlug = uniq('shared-slug');
    await db
      .insert(supportTypes)
      .values({ verticalId: a.id, name: 'Impl A', slug: sharedSlug })
      .returning();
    // Same slug under a DIFFERENT vertical must be allowed (would throw on the
    // old global unique).
    await expect(
      db.insert(supportTypes).values({ verticalId: b.id, name: 'Impl B', slug: sharedSlug })
    ).resolves.toBeDefined();

    const aTypes = await referenceDataRepository.getSupportTypes(a.id);
    const bTypes = await referenceDataRepository.getSupportTypes(b.id);
    expect(aTypes).toHaveLength(1);
    expect(bTypes).toHaveLength(1);
    expect(aTypes[0]!.slug).toBe(sharedSlug);
    expect(bTypes[0]!.slug).toBe(sharedSlug);
  });

  it('returns an empty array for a vertical with no support types', async () => {
    const v = await createVertical();
    const types = await referenceDataRepository.getSupportTypes(v.id);
    expect(types).toEqual([]);
  });
});

// ── getProductsByVertical ───────────────────────────────────────────────────

describe('referenceDataRepository.getProductsByVertical', () => {
  it('groups active products under their category for the vertical only', async () => {
    const v = await createVertical();
    const other = await createVertical();

    const [cat] = await db
      .insert(categories)
      .values({ verticalId: v.id, name: 'Core', slug: uniq('core'), sortOrder: 0 })
      .returning();
    await db.insert(products).values([
      { verticalId: v.id, categoryId: cat!.id, name: 'P1', slug: uniq('p1'), sortOrder: 0 },
      { verticalId: v.id, categoryId: cat!.id, name: 'P2', slug: uniq('p2'), sortOrder: 1 },
    ]);

    // Another vertical's category/product must not leak in.
    const [otherCat] = await db
      .insert(categories)
      .values({ verticalId: other.id, name: 'Other', slug: uniq('other'), sortOrder: 0 })
      .returning();
    await db
      .insert(products)
      .values({ verticalId: other.id, categoryId: otherCat!.id, name: 'X', slug: uniq('x') });

    const grouped = await referenceDataRepository.getProductsByVertical(v.id);
    const coreGroup = grouped.find((g) => g.category.id === cat!.id);
    expect(coreGroup).toBeDefined();
    expect(coreGroup!.products.map((p) => p.name).sort()).toEqual(['P1', 'P2']);
    // No category from the other vertical.
    expect(grouped.some((g) => g.category.id === otherCat!.id)).toBe(false);
  });
});

// ── getProductsForBriefMapping + product_aliases constraints (BAL-592) ──────

async function createCategory(
  verticalId: string,
  name: string,
  opts: { isActive?: boolean; sortOrder?: number } = {}
): Promise<{ id: string; slug: string }> {
  const slug = uniq('cat');
  const [row] = await db
    .insert(categories)
    .values({
      verticalId,
      name,
      slug,
      isActive: opts.isActive ?? true,
      sortOrder: opts.sortOrder ?? 0,
    })
    .returning();
  if (row === undefined) throw new Error('createCategory: insert returned no row');
  return { id: row.id, slug };
}

async function createProduct(
  verticalId: string,
  categoryId: string | null,
  name: string,
  opts: { isActive?: boolean; sortOrder?: number; aiHint?: string } = {}
): Promise<{ id: string; slug: string }> {
  const slug = uniq('prod');
  const [row] = await db
    .insert(products)
    .values({
      verticalId,
      categoryId,
      name,
      slug,
      isActive: opts.isActive ?? true,
      sortOrder: opts.sortOrder ?? 0,
      aiHint: opts.aiHint ?? null,
    })
    .returning();
  if (row === undefined) throw new Error('createProduct: insert returned no row');
  return { id: row.id, slug };
}

async function createAlias(
  product: { id: string },
  verticalId: string,
  alias: string,
  kind: ProductAliasKind,
  opts: { deletedAt?: Date | null } = {}
): Promise<void> {
  await db.insert(productAliases).values({
    productId: product.id,
    verticalId,
    alias,
    kind,
    deletedAt: opts.deletedAt ?? null,
  });
}

describe('referenceDataRepository.getProductsForBriefMapping', () => {
  it('returns each active product with its hint and its live aliases, ordered by alias', async () => {
    const v = await createVertical();
    const cat = await createCategory(v.id, 'Marketing Cloud');
    const hinted = await createProduct(v.id, cat.id, 'Engagement', {
      sortOrder: 0,
      aiHint: 'Email, SMS and journeys.',
    });
    const plain = await createProduct(v.id, cat.id, 'Intelligence', { sortOrder: 1 });
    await createAlias(hinted, v.id, 'Journey Builder', 'feature');
    await createAlias(hinted, v.id, 'ExactTarget', 'alt_name');
    await createAlias(hinted, v.id, 'Retired Name', 'alt_name', { deletedAt: new Date() });

    const grouped = await referenceDataRepository.getProductsForBriefMapping(v.id);

    // Exact shape: the explicit `columns` allow-list admits nothing else (no `description`,
    // no timestamps, no alias ids).
    expect(grouped).toEqual([
      {
        category: { id: cat.id, name: 'Marketing Cloud', slug: cat.slug, sortOrder: 0 },
        products: [
          {
            id: hinted.id,
            name: 'Engagement',
            slug: hinted.slug,
            sortOrder: 0,
            aiHint: 'Email, SMS and journeys.',
            aliases: [
              { alias: 'ExactTarget', kind: 'alt_name' },
              { alias: 'Journey Builder', kind: 'feature' },
            ],
          },
          {
            id: plain.id,
            name: 'Intelligence',
            slug: plain.slug,
            sortOrder: 1,
            aiHint: null,
            aliases: [],
          },
        ],
      },
    ]);
  });

  it('excludes inactive products, inactive categories, uncategorised products and other verticals', async () => {
    const v = await createVertical();
    const other = await createVertical();
    const activeCat = await createCategory(v.id, 'Active', { sortOrder: 0 });
    const inactiveCat = await createCategory(v.id, 'Inactive', { isActive: false, sortOrder: 1 });
    const kept = await createProduct(v.id, activeCat.id, 'Kept');
    const inactive = await createProduct(v.id, activeCat.id, 'Inactive', { isActive: false });
    const inInactiveCat = await createProduct(v.id, inactiveCat.id, 'Hidden By Category');
    const uncategorised = await createProduct(v.id, null, 'Uncategorised');
    await createAlias(inactive, v.id, 'Inactive Alias', 'feature');
    await createAlias(inInactiveCat, v.id, 'Category Alias', 'feature');
    await createAlias(uncategorised, v.id, 'Orphan Alias', 'feature');
    const otherCat = await createCategory(other.id, 'Other');
    await createProduct(other.id, otherCat.id, 'Elsewhere');

    const grouped = await referenceDataRepository.getProductsForBriefMapping(v.id);

    expect(grouped.map((g) => g.category.id)).toEqual([activeCat.id]);
    expect(grouped.flatMap((g) => g.products.map((p) => p.id))).toEqual([kept.id]);
    expect(grouped.flatMap((g) => g.products.flatMap((p) => p.aliases))).toEqual([]);
  });

  it('excludes a product whose own vertical differs from its category’s vertical', async () => {
    const v = await createVertical();
    const other = await createVertical();
    const cat = await createCategory(v.id, 'Core');
    const kept = await createProduct(v.id, cat.id, 'Kept');
    await createProduct(other.id, cat.id, 'Mismatched');

    const grouped = await referenceDataRepository.getProductsForBriefMapping(v.id);

    expect(grouped.flatMap((g) => g.products.map((p) => p.id))).toEqual([kept.id]);
  });

  it('returns an empty array for a vertical with no categories', async () => {
    const v = await createVertical();
    expect(await referenceDataRepository.getProductsForBriefMapping(v.id)).toEqual([]);
  });
});

/** The savepoint handle `expectConstraintViolation` hands a probe. */
type ProbeTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

describe('product_aliases / products.ai_hint constraints', () => {
  it('rejects a case-variant duplicate alias in the same vertical (23505)', async () => {
    const v = await createVertical();
    const cat = await createCategory(v.id, 'Core');
    const first = await createProduct(v.id, cat.id, 'First');
    const second = await createProduct(v.id, cat.id, 'Second');
    await createAlias(first, v.id, 'Journey Builder', 'feature');

    await expectConstraintViolation(
      '23505',
      (tx) =>
        tx.insert(productAliases).values({
          productId: second.id,
          verticalId: v.id,
          alias: 'JOURNEY builder',
          kind: 'alt_name',
        }),
      'product_alias_vertical_alias_unique_idx'
    );
  });

  it('allows the same alias in another vertical, and again once the live one is soft-deleted', async () => {
    const v = await createVertical();
    const other = await createVertical();
    const product = await createProduct(v.id, (await createCategory(v.id, 'Core')).id, 'P');
    const otherProduct = await createProduct(
      other.id,
      (await createCategory(other.id, 'Core')).id,
      'Q'
    );
    await createAlias(product, v.id, 'Shared Name', 'alt_name', { deletedAt: new Date() });
    await createAlias(product, v.id, 'Shared Name', 'alt_name');
    await createAlias(otherProduct, other.id, 'Shared Name', 'alt_name');

    const rows = await db
      .select({ id: productAliases.id })
      .from(productAliases)
      .where(eq(productAliases.alias, 'Shared Name'));
    expect(rows).toHaveLength(3);
  });

  it('rejects an alias whose vertical is not its product’s vertical (composite FK, 23503)', async () => {
    const v = await createVertical();
    const other = await createVertical();
    const product = await createProduct(v.id, (await createCategory(v.id, 'Core')).id, 'P');

    await expectConstraintViolation(
      '23503',
      (tx) =>
        tx.insert(productAliases).values({
          productId: product.id,
          verticalId: other.id,
          alias: 'Mismatch',
          kind: 'feature',
        }),
      'product_alias_product_vertical_fk'
    );
  });

  it('cascades a hard-deleted product to its aliases', async () => {
    const v = await createVertical();
    const product = await createProduct(v.id, (await createCategory(v.id, 'Core')).id, 'P');
    await createAlias(product, v.id, 'Goes With It', 'feature');

    await db.delete(products).where(eq(products.id, product.id));

    const rows = await db
      .select({ id: productAliases.id })
      .from(productAliases)
      .where(eq(productAliases.productId, product.id));
    expect(rows).toEqual([]);
  });

  it('enforces product_alias_shape: 1–80 chars, no angle brackets or line breaks (23514)', async () => {
    const v = await createVertical();
    const product = await createProduct(v.id, (await createCategory(v.id, 'Core')).id, 'P');
    const insertAlias = (alias: string) => (tx: ProbeTx) =>
      tx
        .insert(productAliases)
        .values({ productId: product.id, verticalId: v.id, alias, kind: 'feature' });

    await expectConstraintViolation('23514', insertAlias('Bad <tag>'), 'product_alias_shape');
    await expectConstraintViolation('23514', insertAlias('Bad > tag'), 'product_alias_shape');
    await expectConstraintViolation('23514', insertAlias('Line\nbreak'), 'product_alias_shape');
    await expectConstraintViolation('23514', insertAlias('Line\rbreak'), 'product_alias_shape');
    await expectConstraintViolation('23514', insertAlias('x'.repeat(81)), 'product_alias_shape');
    await expectConstraintViolation('23514', insertAlias(''), 'product_alias_shape');

    // The boundary itself is accepted.
    await createAlias(product, v.id, 'x'.repeat(80), 'feature');
  });

  it('enforces product_ai_hint_shape: NULL or 1–240 chars, no angle brackets or line breaks (23514)', async () => {
    const v = await createVertical();
    const product = await createProduct(v.id, (await createCategory(v.id, 'Core')).id, 'P');
    const setHint = (aiHint: string) => (tx: ProbeTx) =>
      tx.update(products).set({ aiHint }).where(eq(products.id, product.id));

    await expectConstraintViolation('23514', setHint('y'.repeat(241)), 'product_ai_hint_shape');
    await expectConstraintViolation('23514', setHint('a <b> c'), 'product_ai_hint_shape');
    await expectConstraintViolation('23514', setHint(''), 'product_ai_hint_shape');

    await db
      .update(products)
      .set({ aiHint: 'y'.repeat(240) })
      .where(eq(products.id, product.id));
    await db.update(products).set({ aiHint: null }).where(eq(products.id, product.id));
  });
});

// ── getProjectTagsByVertical ────────────────────────────────────────────────

describe('referenceDataRepository.getProjectTagsByVertical', () => {
  it('groups active tags under their group, ordered by sortOrder', async () => {
    const v = await createVertical();

    // Two groups, inserted out of order, to assert group ordering.
    const groupB = await createProjectTagGroup(v.id, 'Group B', { sortOrder: 1 });
    const groupA = await createProjectTagGroup(v.id, 'Group A', { sortOrder: 0 });

    // Tags under A, out of order, to assert tag ordering within a group.
    const a1 = await createProjectTag(v.id, groupA, 'A-Second', { sortOrder: 1 });
    const a0 = await createProjectTag(v.id, groupA, 'A-First', { sortOrder: 0 });
    const b0 = await createProjectTag(v.id, groupB, 'B-Only', { sortOrder: 0 });

    const grouped = await referenceDataRepository.getProjectTagsByVertical(v.id);

    expect(grouped.map((g) => g.group.id)).toEqual([groupA, groupB]); // group sortOrder asc
    const aGroup = grouped.find((g) => g.group.id === groupA);
    expect(aGroup!.tags.map((t) => t.id)).toEqual([a0, a1]); // tag sortOrder asc
    const bGroup = grouped.find((g) => g.group.id === groupB);
    expect(bGroup!.tags.map((t) => t.id)).toEqual([b0]);
    // Returned shape is the trimmed Pick (id/name/slug/sortOrder).
    expect(Object.keys(aGroup!.group).sort()).toEqual(['id', 'name', 'slug', 'sortOrder']);
    expect(Object.keys(aGroup!.tags[0]!).sort()).toEqual(['id', 'name', 'slug', 'sortOrder']);
  });

  it('excludes inactive groups and inactive tags', async () => {
    const v = await createVertical();

    const activeGroup = await createProjectTagGroup(v.id, 'Active', { sortOrder: 0 });
    const inactiveGroup = await createProjectTagGroup(v.id, 'Inactive', {
      sortOrder: 1,
      isActive: false,
    });

    const activeTag = await createProjectTag(v.id, activeGroup, 'Active tag');
    const inactiveTag = await createProjectTag(v.id, activeGroup, 'Inactive tag', {
      isActive: false,
    });
    // A tag under the inactive group must not surface either.
    await createProjectTag(v.id, inactiveGroup, 'Hidden via group');

    const grouped = await referenceDataRepository.getProjectTagsByVertical(v.id);

    expect(grouped.map((g) => g.group.id)).toEqual([activeGroup]);
    const tagIds = grouped.flatMap((g) => g.tags.map((t) => t.id));
    expect(tagIds).toContain(activeTag);
    expect(tagIds).not.toContain(inactiveTag);
  });

  it('excludes soft-deleted groups and soft-deleted tags', async () => {
    const v = await createVertical();

    const liveGroup = await createProjectTagGroup(v.id, 'Live', { sortOrder: 0 });
    const deletedGroup = await createProjectTagGroup(v.id, 'Deleted', {
      sortOrder: 1,
      deletedAt: new Date(),
    });

    const liveTag = await createProjectTag(v.id, liveGroup, 'Live tag');
    const deletedTag = await createProjectTag(v.id, liveGroup, 'Deleted tag', {
      deletedAt: new Date(),
    });
    await createProjectTag(v.id, deletedGroup, 'Tag under deleted group');

    const grouped = await referenceDataRepository.getProjectTagsByVertical(v.id);

    expect(grouped.map((g) => g.group.id)).toEqual([liveGroup]);
    const tagIds = grouped.flatMap((g) => g.tags.map((t) => t.id));
    expect(tagIds).toContain(liveTag);
    expect(tagIds).not.toContain(deletedTag);
  });

  it('scopes to the requested vertical only', async () => {
    const a = await createVertical();
    const b = await createVertical();

    const groupA = await createProjectTagGroup(a.id, 'A group', { sortOrder: 0 });
    await createProjectTag(a.id, groupA, 'A tag');

    const groupB = await createProjectTagGroup(b.id, 'B group', { sortOrder: 0 });
    const bTag = await createProjectTag(b.id, groupB, 'B tag');

    const grouped = await referenceDataRepository.getProjectTagsByVertical(a.id);

    expect(grouped.map((g) => g.group.id)).toEqual([groupA]);
    expect(grouped.some((g) => g.group.id === groupB)).toBe(false);
    expect(grouped.flatMap((g) => g.tags.map((t) => t.id))).not.toContain(bTag);
  });

  it('returns an empty array for a vertical with no tag groups', async () => {
    const v = await createVertical();
    const grouped = await referenceDataRepository.getProjectTagsByVertical(v.id);
    expect(grouped).toEqual([]);
  });
});
