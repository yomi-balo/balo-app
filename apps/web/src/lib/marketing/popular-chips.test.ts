import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import { POPULAR_CHIP_PRODUCTS, resolvePopularChips } from './popular-chips';

beforeEach(() => {
  vi.clearAllMocks();
});

function buildFullTaxonomy(): ProductTaxonomy {
  return {
    groups: [
      {
        id: 'cat-1',
        name: 'All',
        items: POPULAR_CHIP_PRODUCTS.map((name) => ({ id: `id-${name}`, name })),
      },
    ],
  };
}

describe('POPULAR_CHIP_PRODUCTS', () => {
  it('declares exactly the 7 ref chip names', () => {
    expect(POPULAR_CHIP_PRODUCTS).toEqual([
      'Agentforce',
      'Data Cloud',
      'CPQ',
      'Sales Cloud',
      'Service Cloud',
      'MuleSoft',
      'Tableau',
    ]);
  });
});

describe('resolvePopularChips', () => {
  it('resolves every chip in the declared order when the taxonomy matches', () => {
    const chips = resolvePopularChips(buildFullTaxonomy());
    expect(chips).toEqual(POPULAR_CHIP_PRODUCTS.map((name) => ({ id: `id-${name}`, name })));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('drops a chip whose name has no taxonomy match, and logs it (never silently)', () => {
    const partial: ProductTaxonomy = {
      groups: [{ id: 'cat-1', name: 'All', items: [{ id: 'id-Agentforce', name: 'Agentforce' }] }],
    };
    const chips = resolvePopularChips(partial);
    expect(chips).toEqual([{ id: 'id-Agentforce', name: 'Agentforce' }]);
    expect(log.warn).toHaveBeenCalledWith('Marketing chip has no taxonomy match', {
      name: 'Data Cloud',
    });
    expect(log.warn).toHaveBeenCalledTimes(6);
  });

  it('returns an empty, logged-per-name list against an empty taxonomy', () => {
    const chips = resolvePopularChips({ groups: [] });
    expect(chips).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(POPULAR_CHIP_PRODUCTS.length);
  });
});
