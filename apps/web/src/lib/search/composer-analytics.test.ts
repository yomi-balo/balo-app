import { describe, it, expect } from 'vitest';
import { EMPTY_FILTERS, type SearchFilters } from './filters';
import { buildSearchSnapshot, deriveSearchPath, type ComposerNameMaps } from './composer-analytics';

const nameMaps: ComposerNameMaps = {
  products: { p1: 'Agentforce', p2: 'Sales Cloud' },
  supportTypes: { s1: 'Technical fix' },
  languages: { l1: 'English' },
};

function make(overrides: Partial<SearchFilters> = {}): SearchFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

describe('buildSearchSnapshot', () => {
  it('maps product/support/language ids to names via the supplied maps', () => {
    const snapshot = buildSearchSnapshot(
      make({ products: ['p1', 'p2'], supportTypes: ['s1'], languages: ['l1'] }),
      nameMaps
    );
    expect(snapshot.products).toEqual(['Agentforce', 'Sales Cloud']);
    expect(snapshot.support_types).toEqual(['Technical fix']);
    expect(snapshot.languages).toEqual(['English']);
    expect(snapshot.product_count).toBe(2);
    expect(snapshot.support_count).toBe(1);
    expect(snapshot.language_count).toBe(1);
  });

  it('falls back to the raw id when a name is missing (stale URL)', () => {
    const snapshot = buildSearchSnapshot(make({ products: ['p1', 'unknown'] }), nameMaps);
    expect(snapshot.products).toEqual(['Agentforce', 'unknown']);
  });

  it('emits query_length, never the query text', () => {
    const snapshot = buildSearchSnapshot(make({ q: '  agentforce rollout  ' }), nameMaps);
    expect(snapshot.has_query).toBe(true);
    expect(snapshot.query_length).toBe('agentforce rollout'.length);
    expect(Object.values(snapshot)).not.toContain('agentforce rollout');
  });

  it('treats a whitespace-only query as no query', () => {
    const snapshot = buildSearchSnapshot(make({ q: '   ' }), nameMaps);
    expect(snapshot.has_query).toBe(false);
    expect(snapshot.query_length).toBe(0);
  });

  it('maps timeframe null to the "any" sentinel', () => {
    expect(buildSearchSnapshot(make({ timeframe: null }), nameMaps).timeframe).toBe('any');
    expect(buildSearchSnapshot(make({ timeframe: 'today' }), nameMaps).timeframe).toBe('today');
  });

  it('reports rate bounds and has_rate_filter from the dollar fields', () => {
    expect(buildSearchSnapshot(make(), nameMaps).has_rate_filter).toBe(false);
    const withMin = buildSearchSnapshot(make({ rateMinDollars: 2 }), nameMaps);
    expect(withMin.has_rate_filter).toBe(true);
    expect(withMin.rate_min).toBe(2);
    expect(withMin.rate_max).toBeNull();
    const withMax = buildSearchSnapshot(make({ rateMaxDollars: 8 }), nameMaps);
    expect(withMax.has_rate_filter).toBe(true);
    expect(withMax.rate_max).toBe(8);
  });
});

describe('deriveSearchPath', () => {
  it('returns "none" when nothing is set', () => {
    expect(deriveSearchPath(buildSearchSnapshot(make(), nameMaps))).toBe('none');
  });

  it('returns "query_only" when only the query is set', () => {
    expect(deriveSearchPath(buildSearchSnapshot(make({ q: 'flows' }), nameMaps))).toBe(
      'query_only'
    );
  });

  it('returns "facets_only" for products with no query', () => {
    expect(deriveSearchPath(buildSearchSnapshot(make({ products: ['p1'] }), nameMaps))).toBe(
      'facets_only'
    );
  });

  it('returns "facets_only" for a timeframe with no query', () => {
    expect(deriveSearchPath(buildSearchSnapshot(make({ timeframe: 'week' }), nameMaps))).toBe(
      'facets_only'
    );
  });

  it('returns "facets_only" for a rate filter with no query', () => {
    expect(deriveSearchPath(buildSearchSnapshot(make({ rateMinDollars: 1 }), nameMaps))).toBe(
      'facets_only'
    );
  });

  it('returns "both" when query and facets are set', () => {
    expect(
      deriveSearchPath(buildSearchSnapshot(make({ q: 'flows', supportTypes: ['s1'] }), nameMaps))
    ).toBe('both');
  });
});
