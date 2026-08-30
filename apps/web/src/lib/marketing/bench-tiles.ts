import 'server-only';
import { log } from '@/lib/logging';
import { EMPTY_FILTERS, serializeSearchFilters } from '@/lib/search/filters';
import { flattenTaxonomyOptions, type ProductTaxonomy } from '@/lib/search/taxonomy';
import type { FacetCountDTO } from '@/lib/search/search-data';

/**
 * BAL-493 §4.3 — the 18 marketing-home "bench" tiles.
 *
 * Neutral Lucide glyph keys, mapped to actual `lucide-react` components by
 * `apps/web/src/app/(marketing)/_home/icons.ts` (P4) — nothing else imports Lucide by ref-key.
 * Real Salesforce product logos are blocked on trademark review; out of scope here.
 */
export type MarketingBenchIconKey =
  | 'trending'
  | 'headset'
  | 'sparkles'
  | 'database'
  | 'banknote'
  | 'megaphone'
  | 'code'
  | 'globe'
  | 'chart'
  | 'gitMerge'
  | 'wrench'
  | 'mail'
  | 'bag'
  | 'landmark'
  | 'hash'
  | 'activity'
  | 'heart';

/** The five ref tint tokens — CSS classes `.mk-mark-{tint}` in `marketing-home.css` (P1). */
export type MarketingBenchTint = 'blue' | 'violet' | 'teal' | 'amber' | 'slate';

export type MarketingBenchRow = 'A' | 'B';

export interface MarketingBenchTileDef {
  /** The EXACT taxonomy product name this tile resolves against (case-sensitive). */
  product: string;
  /**
   * Display label. May differ from `product` ONLY by prefixing the category name, to
   * restore context the flat bench strips away (Decision 3) — always `label.endsWith(product)`.
   */
  label: string;
  icon: MarketingBenchIconKey;
  tint: MarketingBenchTint;
  row: MarketingBenchRow;
}

/**
 * ⚠ Decision 1 — a tile carries exactly ONE product id, never several: `facetCounts` is
 * `count(DISTINCT expert_profile_id)` PER PRODUCT, so summing a category's products would
 * double-count every expert with two competencies in it.
 *
 * ⚠ Decision 4 — `Flow & Automation` is DROPPED (no taxonomy referent at any level; see the
 * PR follow-up note) and `Tableau & CRM Analytics` is SPLIT into rows #9/#10. Net: still 18.
 *
 * ⚠ Watch the spelling: the seed has CATEGORY `Mulesoft` but PRODUCT `MuleSoft` — tiles match
 * on the PRODUCT name, case-sensitively. Every product below is verified against
 * `packages/db/src/seed.ts`'s `PRODUCT_CATEGORIES`.
 */
export const MARKETING_BENCH_TILES: readonly MarketingBenchTileDef[] = [
  { product: 'Sales Cloud', label: 'Sales Cloud', icon: 'trending', tint: 'blue', row: 'A' },
  { product: 'Service Cloud', label: 'Service Cloud', icon: 'headset', tint: 'violet', row: 'A' },
  { product: 'Agentforce', label: 'Agentforce', icon: 'sparkles', tint: 'violet', row: 'A' },
  { product: 'Data Cloud', label: 'Data Cloud', icon: 'database', tint: 'blue', row: 'A' },
  { product: 'CPQ', label: 'CPQ', icon: 'banknote', tint: 'teal', row: 'A' },
  {
    product: 'Engagement',
    label: 'Marketing Cloud Engagement',
    icon: 'megaphone',
    tint: 'amber',
    row: 'A',
  },
  {
    product: 'Salesforce Platform',
    label: 'Salesforce Platform',
    icon: 'code',
    tint: 'slate',
    row: 'A',
  },
  {
    product: 'Experience Cloud',
    label: 'Experience Cloud',
    icon: 'globe',
    tint: 'blue',
    row: 'A',
  },
  { product: 'Tableau', label: 'Tableau', icon: 'chart', tint: 'amber', row: 'A' },
  { product: 'CRM Analytics', label: 'CRM Analytics', icon: 'chart', tint: 'amber', row: 'B' },
  { product: 'MuleSoft', label: 'MuleSoft', icon: 'gitMerge', tint: 'blue', row: 'B' },
  { product: 'Field Service', label: 'Field Service', icon: 'wrench', tint: 'slate', row: 'B' },
  {
    product: 'Account Engagement',
    label: 'Account Engagement',
    icon: 'mail',
    tint: 'teal',
    row: 'B',
  },
  { product: 'B2C Commerce', label: 'B2C Commerce', icon: 'bag', tint: 'violet', row: 'B' },
  {
    product: 'Financial Services Cloud',
    label: 'Financial Services Cloud',
    icon: 'landmark',
    tint: 'teal',
    row: 'B',
  },
  { product: 'Slack', label: 'Slack', icon: 'hash', tint: 'violet', row: 'B' },
  { product: 'Health Cloud', label: 'Health Cloud', icon: 'activity', tint: 'teal', row: 'B' },
  {
    product: 'Nonprofit Cloud',
    label: 'Nonprofit Cloud',
    icon: 'heart',
    tint: 'amber',
    row: 'B',
  },
] as const;

export interface ResolvedBenchTile {
  productId: string;
  product: string;
  label: string;
  icon: MarketingBenchIconKey;
  tint: MarketingBenchTint;
  row: MarketingBenchRow;
  /** `/experts?products=<uuid>` — built via `serializeSearchFilters`, never hand-built. */
  href: string;
  /** Decade-bucketed count (`Math.floor(rawCount / 10) * 10`) — the flicker fix (§4.4). */
  displayCount: number;
  /** `false` below 10 real experts — the count LINE hides, the tile never does. */
  showCount: boolean;
  /** Never announces a number the page is hiding (F13). */
  ariaLabel: string;
}

function buildProductNameToIdMap(taxonomy: ProductTaxonomy): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of flattenTaxonomyOptions(taxonomy)) {
    if (!map.has(item.name)) map.set(item.name, item.id);
  }
  return map;
}

function buildTileHref(productId: string): string {
  const params = serializeSearchFilters({ ...EMPTY_FILTERS, products: [productId] });
  return `/experts?${params.toString()}`;
}

/**
 * Resolve the 18 static tile definitions against the live taxonomy + facet counts.
 *
 * A tile whose `product` has no taxonomy match is DROPPED and logged (Decision 2) — in
 * practice unreachable for the shipped 18 (every name is verified against the seed), but a
 * taxonomy rename must degrade, not break.
 */
export function resolveBenchTiles(
  taxonomy: ProductTaxonomy,
  facetProductCounts: readonly FacetCountDTO[]
): ResolvedBenchTile[] {
  const nameToId = buildProductNameToIdMap(taxonomy);
  const idToCount = new Map(facetProductCounts.map((f) => [f.id, f.count]));

  const resolved: ResolvedBenchTile[] = [];
  for (const tile of MARKETING_BENCH_TILES) {
    const productId = nameToId.get(tile.product);
    if (productId === undefined) {
      log.warn('Marketing bench tile has no taxonomy match', { product: tile.product });
      continue;
    }

    const rawCount = idToCount.get(productId) ?? 0;
    const showCount = rawCount >= 10;
    const displayCount = Math.floor(rawCount / 10) * 10;

    resolved.push({
      productId,
      product: tile.product,
      label: tile.label,
      icon: tile.icon,
      tint: tile.tint,
      row: tile.row,
      href: buildTileHref(productId),
      displayCount,
      showCount,
      ariaLabel: showCount ? `${tile.label} — ${displayCount}+ experts` : tile.label,
    });
  }
  return resolved;
}
