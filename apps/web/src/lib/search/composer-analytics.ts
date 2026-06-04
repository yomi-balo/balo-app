/**
 * Pure builder for the shared Search Composer analytics snapshot. Produces the
 * property bag shared by `search_submitted` and `search_refined`, and derives the
 * headline `path` metric. No `track()` call here — the component fires; this just
 * shapes the props so the logic is unit-testable in isolation.
 *
 * Privacy: emits `query_length`, never the query text. Product/support/language
 * values are non-sensitive taxonomy terms (safe + valuable for supply recruiting).
 */

import type { SearchFilters } from './filters';

/** id→name lookups: products from the taxonomy, support/languages from facetCounts. */
export interface ComposerNameMaps {
  products: Record<string, string>;
  supportTypes: Record<string, string>;
  languages: Record<string, string>;
}

/** Timeframe as emitted to analytics — `null` collapses to the `'any'` sentinel. */
export type AnalyticsTimeframe = 'any' | 'today' | '3days' | 'week';

/** The shared snapshot both submit + refine carry. */
export interface SearchSnapshot {
  has_query: boolean;
  query_length: number;
  products: string[];
  product_count: number;
  support_types: string[];
  support_count: number;
  timeframe: AnalyticsTimeframe;
  has_rate_filter: boolean;
  rate_min: number | null;
  rate_max: number | null;
  languages: string[];
  language_count: number;
}

/** The first-class headline metric for `search_submitted`. */
export type SearchPath = 'query_only' | 'facets_only' | 'both' | 'none';

/** Map a list of ids → names, falling back to the id when unknown (stale URL). */
function mapNames(ids: string[], nameMap: Record<string, string>): string[] {
  return ids.map((id) => nameMap[id] ?? id);
}

/** Build the shared snapshot from the committed filters + id→name maps. */
export function buildSearchSnapshot(
  filters: SearchFilters,
  nameMaps: ComposerNameMaps
): SearchSnapshot {
  const trimmedQuery = filters.q.trim();
  const hasRateFilter = filters.rateMinDollars != null || filters.rateMaxDollars != null;

  return {
    has_query: trimmedQuery !== '',
    query_length: trimmedQuery.length,
    products: mapNames(filters.products, nameMaps.products),
    product_count: filters.products.length,
    support_types: mapNames(filters.supportTypes, nameMaps.supportTypes),
    support_count: filters.supportTypes.length,
    timeframe: filters.timeframe ?? 'any',
    has_rate_filter: hasRateFilter,
    rate_min: filters.rateMinDollars,
    rate_max: filters.rateMaxDollars,
    languages: mapNames(filters.languages, nameMaps.languages),
    language_count: filters.languages.length,
  };
}

/** Derive the headline `path` from a snapshot (submit-only metric). */
export function deriveSearchPath(snapshot: SearchSnapshot): SearchPath {
  const hasQuery = snapshot.has_query;
  const hasFacets =
    snapshot.product_count + snapshot.support_count + snapshot.language_count > 0 ||
    snapshot.timeframe !== 'any' ||
    snapshot.has_rate_filter;

  if (hasQuery && hasFacets) return 'both';
  if (hasQuery) return 'query_only';
  if (hasFacets) return 'facets_only';
  return 'none';
}
