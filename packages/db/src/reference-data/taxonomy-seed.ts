import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import * as schema from '../schema';
import type { NewProductAlias, ProductAliasKind } from '../schema';
import type { ProductAliasSeed } from './salesforce-taxonomy';

/**
 * Reference-data seeders shared by `seed.ts` and the integration tests, so a test exercises the
 * exact code path a fresh environment is seeded with. Every function takes the `db` to write
 * through rather than opening its own connection.
 */

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[()]/g, '')
    .replaceAll(/[&/]/g, '-')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '');
}

/**
 * Seed categories → products → support types for ONE vertical. Used for BOTH
 * Salesforce and the mock `acme` vertical — proving the seeder hardcodes no
 * vertical-specific taxonomy. Idempotent (onConflictDoNothing on the composite
 * (vertical_id, slug) uniques).
 */
export async function seedTaxonomyForVertical(
  db: Database,
  verticalId: string,
  categories: Array<[string, string, string[]]>,
  supportTypes: Array<[string, string]>
): Promise<void> {
  // Categories.
  await db
    .insert(schema.categories)
    .values(categories.map(([name, slug], i) => ({ name, slug, verticalId, sortOrder: i })))
    .onConflictDoNothing();

  const catRows = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.verticalId, verticalId));
  const catMap = Object.fromEntries(catRows.map((c) => [c.slug, c.id]));

  // Products.
  const productValues = categories.flatMap(([, catSlug, names]) =>
    names.map((name, i) => ({
      name,
      slug: slugify(name),
      verticalId,
      categoryId: catMap[catSlug],
      sortOrder: i,
    }))
  );
  if (productValues.length > 0) {
    await db.insert(schema.products).values(productValues).onConflictDoNothing();
  }

  // Support types (vertical-scoped).
  if (supportTypes.length > 0) {
    await db
      .insert(schema.supportTypes)
      .values(supportTypes.map(([name, slug], i) => ({ name, slug, verticalId, sortOrder: i })))
      .onConflictDoNothing();
  }
}

/** One `product_aliases` row of a seed constant, before its product id is resolved. */
export interface ProductAliasSeedRow {
  readonly slug: string;
  readonly alias: string;
  readonly kind: ProductAliasKind;
}

/**
 * BAL-592 — a seed constant's alias rows in their one canonical order: the constant's slug order,
 * and within a slug its `features` before its `altNames`. Both the TypeScript seeder and the SQL
 * renderer read rows through this, so the two paths cannot disagree on the row set.
 */
export function flattenProductAliasSeed(
  aliases: Readonly<Record<string, ProductAliasSeed>>
): ProductAliasSeedRow[] {
  return Object.entries(aliases).flatMap(([slug, seed]) => [
    ...seed.features.map((alias) => ({ slug, alias, kind: 'feature' as const })),
    ...seed.altNames.map((alias) => ({ slug, alias, kind: 'alt_name' as const })),
  ]);
}

/**
 * BAL-592 — seed `product_aliases` rows and `products.ai_hint` for ONE vertical from a seed
 * constant. Run AFTER `seedTaxonomyForVertical`: product ids are resolved by slug within the
 * vertical, and a slug with no product THROWS — a typo in the constant must fail the seed, not
 * silently drop that product's aliases.
 *
 * Idempotent: alias inserts skip any row that already exists (`onConflictDoNothing` with no
 * target, so the partial unique index needs no arbiter inference), and the hint update writes the
 * same value again.
 */
export async function seedProductAliasesForVertical(
  db: Database,
  verticalId: string,
  aliases: Readonly<Record<string, ProductAliasSeed>>
): Promise<void> {
  const slugs = Object.keys(aliases);
  if (slugs.length === 0) return;

  const productRows = await db
    .select({ id: schema.products.id, slug: schema.products.slug })
    .from(schema.products)
    .where(and(eq(schema.products.verticalId, verticalId), inArray(schema.products.slug, slugs)));
  const productIdBySlug = new Map(productRows.map((p) => [p.slug, p.id]));

  const resolveProductId = (slug: string): string => {
    const productId = productIdBySlug.get(slug);
    if (productId === undefined) {
      throw new Error(`Product not found for alias seed slug "${slug}"`);
    }
    return productId;
  };

  // Every slug is resolved before the first write, so a bad slug leaves nothing half-seeded.
  const hintUpdates = Object.entries(aliases).flatMap(([slug, seed]) => {
    const productId = resolveProductId(slug);
    return seed.hint === undefined ? [] : [{ productId, hint: seed.hint }];
  });
  const aliasValues: NewProductAlias[] = flattenProductAliasSeed(aliases).map((row) => ({
    productId: resolveProductId(row.slug),
    verticalId,
    alias: row.alias,
    kind: row.kind,
  }));

  for (const { productId, hint } of hintUpdates) {
    await db.update(schema.products).set({ aiHint: hint }).where(eq(schema.products.id, productId));
  }

  if (aliasValues.length > 0) {
    await db.insert(schema.productAliases).values(aliasValues).onConflictDoNothing();
  }
}

/** A single-quoted SQL string literal; `'` is doubled. */
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** `(a, b, c)` rows of a `VALUES` list, one per line. */
function renderValuesRows(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => `  (${row.map(sqlLiteral).join(', ')})`).join(',\n');
}

/**
 * BAL-592 — render a seed constant as the SQL a migration embeds to seed an EXISTING environment
 * (one whose products already exist). Pure. Two statements, joined by drizzle's statement
 * breakpoint, rows in {@link flattenProductAliasSeed} order:
 *  1. `INSERT … SELECT` of the alias rows, resolving each product id by slug within the vertical
 *     named by `verticalSlug` — never a hardcoded uuid — with `ON CONFLICT DO NOTHING`;
 *  2. `UPDATE products SET ai_hint` for each slug that has a hint, matched the same way.
 * A slug with no matching product matches no row, so on a fresh database (products not yet
 * seeded) both statements are no-ops; `seed.ts` seeds those environments instead. A statement
 * whose row list would be empty is omitted.
 *
 * `invariants/product-alias-migration-matches-the-seed-constant.test.ts` asserts migration 0105
 * contains this function's output for the Salesforce constant verbatim.
 */
export function renderProductAliasSeedSql(
  verticalSlug: string,
  aliases: Readonly<Record<string, ProductAliasSeed>>
): string {
  const vertical = sqlLiteral(verticalSlug);
  const statements: string[] = [];

  const aliasRows = flattenProductAliasSeed(aliases).map((row) => [row.slug, row.alias, row.kind]);
  if (aliasRows.length > 0) {
    statements.push(
      [
        'INSERT INTO "product_aliases" ("product_id", "vertical_id", "alias", "kind")',
        'SELECT p."id", p."vertical_id", v.alias, v.kind::"product_alias_kind"',
        'FROM (VALUES',
        renderValuesRows(aliasRows),
        ') AS v(slug, alias, kind)',
        'JOIN "products" p ON p."slug" = v.slug',
        `JOIN "verticals" vt ON vt."id" = p."vertical_id" AND vt."slug" = ${vertical}`,
        'ON CONFLICT DO NOTHING;',
      ].join('\n')
    );
  }

  const hintRows = Object.entries(aliases).flatMap(([slug, seed]) =>
    seed.hint === undefined ? [] : [[slug, seed.hint]]
  );
  if (hintRows.length > 0) {
    statements.push(
      [
        'UPDATE "products" p SET "ai_hint" = v.hint',
        'FROM (VALUES',
        renderValuesRows(hintRows),
        ') AS v(slug, hint), "verticals" vt',
        `WHERE p."slug" = v.slug AND vt."id" = p."vertical_id" AND vt."slug" = ${vertical};`,
      ].join('\n')
    );
  }

  return statements.join('\n--> statement-breakpoint\n');
}
