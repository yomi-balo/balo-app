import { describe, it, expect } from 'vitest';
import { db } from '../client';
import { verticals, categories, products, supportTypes } from '../schema';
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
