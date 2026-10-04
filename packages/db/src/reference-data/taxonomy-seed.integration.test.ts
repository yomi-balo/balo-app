import { describe, it, expect } from 'vitest';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import { productAliases, products } from '../schema';
import { referenceDataRepository } from '../repositories/reference-data';
import { PRODUCT_CATEGORIES, SALESFORCE_PRODUCT_ALIASES } from './salesforce-taxonomy';
import {
  flattenProductAliasSeed,
  renderProductAliasSeedSql,
  seedProductAliasesForVertical,
  seedTaxonomyForVertical,
} from './taxonomy-seed';

/**
 * BAL-592 AC7 — the Salesforce alias seed against real Postgres, through BOTH paths that write
 * it: the `seed.ts` functions (fresh environments) and migration 0105's SQL (existing ones).
 *
 * The integration database is migrated EMPTY — global-setup seeds only the `salesforce` vertical,
 * after the migrations ran — so 0105's seed statements were no-ops there by design. Each test
 * seeds the Salesforce products itself (rolled back per test) and, for the SQL path, executes
 * the statements `renderProductAliasSeedSql` renders — the exact text 0105 ends with (pinned by
 * `invariants/product-alias-migration-matches-the-seed-constant.test.ts`).
 */

const EXPECTED_ALIASES = flattenProductAliasSeed(SALESFORCE_PRODUCT_ALIASES)
  .map((row) => `${row.slug}|${row.kind}|${row.alias}`)
  .sort((a, b) => a.localeCompare(b));
const EXPECTED_HINTS = Object.entries(SALESFORCE_PRODUCT_ALIASES)
  .flatMap(([slug, seed]) => (seed.hint === undefined ? [] : [`${slug}|${seed.hint}`]))
  .sort((a, b) => a.localeCompare(b));

async function salesforceVerticalId(): Promise<string> {
  return (await referenceDataRepository.getSalesforceVertical()).id;
}

async function seedSalesforceProducts(verticalId: string): Promise<void> {
  await seedTaxonomyForVertical(db, verticalId, PRODUCT_CATEGORIES, []);
}

/** Every live alias and every hint in the vertical, as sorted, comparable strings. */
async function readSeededState(
  verticalId: string
): Promise<{ aliases: string[]; hints: string[] }> {
  const aliasRows = await db
    .select({ slug: products.slug, kind: productAliases.kind, alias: productAliases.alias })
    .from(productAliases)
    .innerJoin(products, eq(products.id, productAliases.productId))
    .where(and(eq(productAliases.verticalId, verticalId), isNull(productAliases.deletedAt)));
  const hintRows = await db
    .select({ slug: products.slug, hint: products.aiHint })
    .from(products)
    .where(and(eq(products.verticalId, verticalId), isNotNull(products.aiHint)));
  return {
    aliases: aliasRows
      .map((r) => `${r.slug}|${r.kind}|${r.alias}`)
      .sort((a, b) => a.localeCompare(b)),
    hints: hintRows.map((r) => `${r.slug}|${r.hint ?? ''}`).sort((a, b) => a.localeCompare(b)),
  };
}

async function countAliases(verticalId: string): Promise<number> {
  const rows = await db
    .select({ id: productAliases.id })
    .from(productAliases)
    .where(eq(productAliases.verticalId, verticalId));
  return rows.length;
}

async function runMigrationSeedSql(): Promise<void> {
  const rendered = renderProductAliasSeedSql('salesforce', SALESFORCE_PRODUCT_ALIASES);
  for (const statement of rendered.split('--> statement-breakpoint')) {
    await db.execute(sql.raw(statement));
  }
}

describe('seedProductAliasesForVertical (the seed.ts path)', () => {
  it('seeds every Salesforce alias and hint, and the database accepts them all', async () => {
    const verticalId = await salesforceVerticalId();
    await seedSalesforceProducts(verticalId);

    await seedProductAliasesForVertical(db, verticalId, SALESFORCE_PRODUCT_ALIASES);

    expect(EXPECTED_ALIASES.length).toBeGreaterThan(100);
    expect(await readSeededState(verticalId)).toEqual({
      aliases: EXPECTED_ALIASES,
      hints: EXPECTED_HINTS,
    });
  });

  it('is idempotent: a re-run leaves the row count and content unchanged', async () => {
    const verticalId = await salesforceVerticalId();
    await seedSalesforceProducts(verticalId);
    await seedProductAliasesForVertical(db, verticalId, SALESFORCE_PRODUCT_ALIASES);
    const firstCount = await countAliases(verticalId);

    await seedSalesforceProducts(verticalId);
    await seedProductAliasesForVertical(db, verticalId, SALESFORCE_PRODUCT_ALIASES);

    expect(await countAliases(verticalId)).toBe(firstCount);
    expect(firstCount).toBe(EXPECTED_ALIASES.length);
    expect(await readSeededState(verticalId)).toEqual({
      aliases: EXPECTED_ALIASES,
      hints: EXPECTED_HINTS,
    });
  });

  it('throws on a slug with no product, before writing anything', async () => {
    const verticalId = await salesforceVerticalId();
    await seedSalesforceProducts(verticalId);

    await expect(
      seedProductAliasesForVertical(db, verticalId, {
        engagement: { features: ['Journey Builder'], altNames: [], hint: 'Would be written.' },
        'no-such-product': { features: ['Ghost'], altNames: [] },
      })
    ).rejects.toThrow('Product not found for alias seed slug "no-such-product"');

    expect(await readSeededState(verticalId)).toEqual({ aliases: [], hints: [] });
  });
});

describe('migration 0105 seed SQL (the existing-environment path)', () => {
  it('yields exactly the alias set and hints the seed.ts path does, and re-runs cleanly', async () => {
    const verticalId = await salesforceVerticalId();
    await seedSalesforceProducts(verticalId);

    await runMigrationSeedSql();
    const viaSql = await readSeededState(verticalId);
    await runMigrationSeedSql();

    expect(viaSql).toEqual({ aliases: EXPECTED_ALIASES, hints: EXPECTED_HINTS });
    expect(await readSeededState(verticalId)).toEqual(viaSql);
    expect(await countAliases(verticalId)).toBe(EXPECTED_ALIASES.length);
  });

  it('is a no-op on a database whose products do not exist yet', async () => {
    const verticalId = await salesforceVerticalId();

    await runMigrationSeedSql();

    expect(await countAliases(verticalId)).toBe(0);
  });
});

describe('the seeded aliases through referenceDataRepository.getProductsForBriefMapping', () => {
  it('returns engagement under Marketing Cloud with its features, other names and hint', async () => {
    const verticalId = await salesforceVerticalId();
    await seedSalesforceProducts(verticalId);
    await seedProductAliasesForVertical(db, verticalId, SALESFORCE_PRODUCT_ALIASES);

    const grouped = await referenceDataRepository.getProductsForBriefMapping(verticalId);
    const marketing = grouped.find((g) => g.category.slug === 'marketing-cloud');
    const engagement = marketing?.products.find((p) => p.slug === 'engagement');

    expect(engagement?.aiHint).toBe(SALESFORCE_PRODUCT_ALIASES.engagement?.hint);
    expect(engagement?.aliases).toContainEqual({ alias: 'Journey Builder', kind: 'feature' });
    expect(engagement?.aliases).toContainEqual({ alias: 'ExactTarget', kind: 'alt_name' });
    expect(engagement?.aliases).toHaveLength(
      flattenProductAliasSeed(SALESFORCE_PRODUCT_ALIASES).filter((r) => r.slug === 'engagement')
        .length
    );
  });

  it('never returns the aliases of a deactivated product (AC4)', async () => {
    const verticalId = await salesforceVerticalId();
    await seedSalesforceProducts(verticalId);
    await seedProductAliasesForVertical(db, verticalId, SALESFORCE_PRODUCT_ALIASES);
    await db
      .update(products)
      .set({ isActive: false })
      .where(and(eq(products.verticalId, verticalId), eq(products.slug, 'engagement')));

    const grouped = await referenceDataRepository.getProductsForBriefMapping(verticalId);
    const returned = grouped.flatMap((g) => g.products);
    const returnedAliases = returned.flatMap((p) => p.aliases.map((a) => a.alias));

    expect(returned.some((p) => p.slug === 'engagement')).toBe(false);
    expect(returnedAliases).not.toContain('Journey Builder');
    expect(returnedAliases).not.toContain('ExactTarget');
    // The rest of the taxonomy is unaffected.
    expect(returned.some((p) => p.slug === 'account-engagement')).toBe(true);
  });
});
