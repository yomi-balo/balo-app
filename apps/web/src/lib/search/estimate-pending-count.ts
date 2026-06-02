import type { FacetCountDTO } from './search-data';
import type { SearchFilters } from './filters';

interface FacetCounts {
  products: FacetCountDTO[];
  supportTypes: FacetCountDTO[];
  languages: FacetCountDTO[];
}

/** Sum the counts of the selected facet ids within a single facet group. */
function sumSelected(group: FacetCountDTO[], selectedIds: string[]): number {
  if (selectedIds.length === 0) return 0;
  const selected = new Set(selectedIds);
  return group.reduce((acc, facet) => (selected.has(facet.id) ? acc + facet.count : acc), 0);
}

/**
 * Optimistic, fetch-free estimate of how many experts the pending filters would
 * match — drives the mobile sheet's "Show N experts" footer so the filter→count
 * feedback stays live without a per-keystroke network round-trip.
 *
 * - No facet group selected → `total` (other filters can only narrow further, but
 *   facet counts are selection-independent so we cannot estimate their effect).
 * - Otherwise → the minimum, across each non-empty facet group, of the summed
 *   selected facet counts in that group, clamped to `[0, total]`.
 *
 * This is deliberately an estimate; the authoritative count appears once "Show"
 * navigates and the RSC refetches.
 */
export function estimatePendingCount(
  facetCounts: FacetCounts,
  pendingFilters: SearchFilters,
  total: number
): number {
  const groupSums: number[] = [];

  if (pendingFilters.products.length > 0) {
    groupSums.push(sumSelected(facetCounts.products, pendingFilters.products));
  }
  if (pendingFilters.supportTypes.length > 0) {
    groupSums.push(sumSelected(facetCounts.supportTypes, pendingFilters.supportTypes));
  }
  if (pendingFilters.languages.length > 0) {
    groupSums.push(sumSelected(facetCounts.languages, pendingFilters.languages));
  }

  if (groupSums.length === 0) {
    return Math.max(0, total);
  }

  const estimate = Math.min(...groupSums);
  return Math.max(0, Math.min(estimate, total));
}
