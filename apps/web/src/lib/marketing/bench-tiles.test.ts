import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import type { FacetCountDTO } from '@/lib/search/search-data';
import { MARKETING_BENCH_TILES, resolveBenchTiles } from './bench-tiles';

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * BAL-493 fix round 2 (review MAJOR 7) — transcribed VERBATIM from
 * `packages/db/src/seed.ts`'s `PRODUCT_CATEGORIES` (13 categories, 39 products), NOT derived
 * from `MARKETING_BENCH_TILES`. `seed.ts` cannot be imported directly here — it is a script
 * with top-level side effects (it opens a real Postgres connection and calls `process.exit` on
 * the module's own top-level `(async () => {...})()`), so this is a literal copy, not a shared
 * import. A typo'd product name (e.g. `Mulesoft` instead of `MuleSoft`) or an invented one
 * (`Flow & Automation`) below would make `resolveBenchTiles` silently drop the tile the
 * "resolves every tile" test checks for — which is exactly the guard the self-referential
 * fixture this replaces could never provide.
 */
const SEED_PRODUCT_CATEGORIES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['AI', ['Agentforce']],
  ['Data Cloud', ['Data Cloud']],
  ['Sales Cloud', ['CPQ', 'Sales Cloud']],
  ['Service Cloud', ['Digital Engagement', 'Field Service', 'Service Cloud', 'Voice']],
  [
    'Marketing Cloud',
    ['Account Engagement', 'Engagement', 'Intelligence', 'Loyalty Management', 'Personalisation'],
  ],
  ['Slack', ['Slack']],
  ['Experience Cloud', ['Experience Cloud']],
  ['Commerce Cloud', ['B2B Commerce', 'B2C Commerce', 'Order Management']],
  [
    'Platform',
    ['AppExchange', 'Heroku', 'Hyperforce', 'Salesforce Platform', 'Security', 'Shield'],
  ],
  ['Tableau', ['CRM Analytics', 'Tableau']],
  ['Mulesoft', ['MuleSoft']],
  [
    'Industry Clouds',
    [
      'Communications Cloud',
      'Consumer Goods Cloud',
      'Education Cloud',
      'Energy & Utilities Cloud',
      'Financial Services Cloud',
      'Government Cloud',
      'Health Cloud',
      'Manufacturing Cloud',
      'Media Cloud',
      'Nonprofit Cloud',
      'OmniStudio',
    ],
  ],
  ['Net Zero Cloud', ['Net Zero Cloud']],
];

/** A real taxonomy built from the seed's 13 categories / 39 products, id = `id-<product>`. */
function buildFullTaxonomy(): ProductTaxonomy {
  return {
    groups: SEED_PRODUCT_CATEGORIES.map(([categoryName, products], index) => ({
      id: `cat-${index}`,
      name: categoryName,
      items: products.map((name) => ({ id: `id-${name}`, name })),
    })),
  };
}

describe('SEED_PRODUCT_CATEGORIES (this file’s own transcription, sanity-checked)', () => {
  it('carries exactly 13 categories and 39 products, matching seed.ts', () => {
    expect(SEED_PRODUCT_CATEGORIES).toHaveLength(13);
    const allProducts = SEED_PRODUCT_CATEGORIES.flatMap(([, products]) => products);
    expect(allProducts).toHaveLength(39);
    expect(new Set(allProducts).size).toBe(39);
  });
});

describe('MARKETING_BENCH_TILES', () => {
  it('ships exactly 18 tiles', () => {
    expect(MARKETING_BENCH_TILES).toHaveLength(18);
  });

  it('every label carries its product name as a suffix (Decision 3)', () => {
    for (const tile of MARKETING_BENCH_TILES) {
      expect(tile.label.endsWith(tile.product)).toBe(true);
    }
  });

  it('splits into exactly 9 tiles per row — not just the row {A,B} SET (a 17/1 split must fail)', () => {
    expect(MARKETING_BENCH_TILES.filter((t) => t.row === 'A')).toHaveLength(9);
    expect(MARKETING_BENCH_TILES.filter((t) => t.row === 'B')).toHaveLength(9);
  });

  it('never repeats a product across tiles (each carries exactly one id)', () => {
    const products = MARKETING_BENCH_TILES.map((t) => t.product);
    expect(new Set(products).size).toBe(products.length);
  });

  it('every tile product name is a REAL seed product (not a typo or an invented name)', () => {
    const seedProducts = new Set(SEED_PRODUCT_CATEGORIES.flatMap(([, products]) => products));
    for (const tile of MARKETING_BENCH_TILES) {
      expect(seedProducts.has(tile.product)).toBe(true);
    }
  });
});

describe('resolveBenchTiles', () => {
  it('resolves every tile when the taxonomy carries every product', () => {
    const resolved = resolveBenchTiles(buildFullTaxonomy(), []);
    expect(resolved).toHaveLength(18);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('builds the href via serializeSearchFilters — exactly `?products=<id>`, nothing else', () => {
    const resolved = resolveBenchTiles(buildFullTaxonomy(), []);
    const salesCloud = resolved.find((t) => t.product === 'Sales Cloud');
    expect(salesCloud?.href).toBe('/experts?products=id-Sales+Cloud');
  });

  it('drops a tile whose product has no taxonomy match, and logs it', () => {
    const emptyTaxonomy: ProductTaxonomy = { groups: [] };
    const resolved = resolveBenchTiles(emptyTaxonomy, []);
    expect(resolved).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(
      'Marketing bench tile has no taxonomy match',
      expect.objectContaining({ product: expect.any(String) })
    );
    expect(log.warn).toHaveBeenCalledTimes(18);
  });

  it('decade-buckets the count and shows it at/above 10', () => {
    const facetCounts: FacetCountDTO[] = [{ id: 'id-Sales Cloud', name: 'Sales Cloud', count: 67 }];
    const resolved = resolveBenchTiles(buildFullTaxonomy(), facetCounts);
    const salesCloud = resolved.find((t) => t.product === 'Sales Cloud');
    expect(salesCloud?.showCount).toBe(true);
    expect(salesCloud?.displayCount).toBe(60);
    expect(salesCloud?.ariaLabel).toBe('Sales Cloud — 60+ experts');
  });

  it('hides the count line below 10 but never drops the tile — no number in the aria-label', () => {
    const facetCounts: FacetCountDTO[] = [{ id: 'id-Sales Cloud', name: 'Sales Cloud', count: 5 }];
    const resolved = resolveBenchTiles(buildFullTaxonomy(), facetCounts);
    const salesCloud = resolved.find((t) => t.product === 'Sales Cloud');
    expect(salesCloud).toBeDefined();
    expect(salesCloud?.showCount).toBe(false);
    expect(salesCloud?.ariaLabel).toBe('Sales Cloud');
  });

  it('treats a product with zero facet supply as showCount=false, not an error', () => {
    const resolved = resolveBenchTiles(buildFullTaxonomy(), []);
    const salesCloud = resolved.find((t) => t.product === 'Sales Cloud');
    expect(salesCloud?.showCount).toBe(false);
    expect(salesCloud?.displayCount).toBe(0);
  });
});
