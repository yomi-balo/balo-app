import { describe, it, expect } from 'vitest';
import { estimatePendingCount } from './estimate-pending-count';
import { EMPTY_FILTERS, type SearchFilters } from './filters';
import type { FacetCountDTO } from './search-data';

function make(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

const facetCounts: {
  products: FacetCountDTO[];
  supportTypes: FacetCountDTO[];
  languages: FacetCountDTO[];
} = {
  products: [
    { id: 'p1', name: 'Agentforce', count: 18 },
    { id: 'p2', name: 'Sales Cloud', count: 31 },
  ],
  supportTypes: [
    { id: 's1', name: 'Technical', count: 22 },
    { id: 's2', name: 'Strategy', count: 13 },
  ],
  languages: [{ id: 'l1', name: 'English', count: 52 }],
};

describe('estimatePendingCount', () => {
  it('returns total when no facet filters are pending', () => {
    expect(estimatePendingCount(facetCounts, make(), 50)).toBe(50);
  });

  it('sums selected counts within a single group', () => {
    expect(estimatePendingCount(facetCounts, make({ products: ['p1', 'p2'] }), 100)).toBe(49);
  });

  it('takes the minimum across multiple non-empty groups', () => {
    const result = estimatePendingCount(
      facetCounts,
      make({ products: ['p1'], supportTypes: ['s1', 's2'] }),
      100
    );
    // products sum = 18, supportTypes sum = 35 → min = 18
    expect(result).toBe(18);
  });

  it('clamps the estimate to total', () => {
    expect(estimatePendingCount(facetCounts, make({ products: ['p1', 'p2'] }), 10)).toBe(10);
  });

  it('clamps to 0 (never negative) when selected ids are unknown', () => {
    expect(estimatePendingCount(facetCounts, make({ products: ['unknown'] }), 30)).toBe(0);
  });

  it('returns total clamped to 0 when total is negative-ish edge (0)', () => {
    expect(estimatePendingCount(facetCounts, make(), 0)).toBe(0);
  });
});
