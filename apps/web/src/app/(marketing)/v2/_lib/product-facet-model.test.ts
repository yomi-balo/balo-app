import { describe, expect, it } from 'vitest';
import { EMPTY_TAXONOMY, type ProductTaxonomy } from '@/lib/search/taxonomy';
import { DENSE_CAP, FALLBACK_TAXONOMY } from './content';
import {
  facetSummary,
  filterGroups,
  itemKey,
  selectedProductIds,
  toV2Taxonomy,
  visibleItems,
  type V2Taxonomy,
} from './product-facet-model';

const LIVE: ProductTaxonomy = {
  groups: [
    {
      id: 'cat-sales',
      name: 'Sales',
      items: [
        { id: 'prod-sales-cloud', name: 'Sales Cloud' },
        { id: 'prod-cpq', name: 'CPQ' },
      ],
    },
    {
      id: 'cat-data',
      name: 'Data',
      items: [{ id: 'prod-data-cloud', name: 'Data Cloud' }],
    },
  ],
};

describe('toV2Taxonomy', () => {
  it('maps a live taxonomy 1:1 and tags source: "live"', () => {
    const result = toV2Taxonomy(LIVE);
    expect(result.source).toBe('live');
    expect(result.groups).toEqual([
      {
        group: 'Sales',
        items: [
          { id: 'prod-sales-cloud', name: 'Sales Cloud' },
          { id: 'prod-cpq', name: 'CPQ' },
        ],
      },
      { group: 'Data', items: [{ id: 'prod-data-cloud', name: 'Data Cloud' }] },
    ]);
  });

  it('degrades to the ref’s static FALLBACK_TAXONOMY when the live load returns no groups (O1)', () => {
    const result = toV2Taxonomy(EMPTY_TAXONOMY);
    expect(result.source).toBe('fallback');
    expect(result.groups).toHaveLength(FALLBACK_TAXONOMY.length);
    expect(result.groups.map((g) => g.group)).toEqual(FALLBACK_TAXONOMY.map((g) => g.group));
    for (const group of result.groups) {
      for (const item of group.items) {
        expect(item.id).toBeNull();
      }
    }
  });
});

// Reused across the filter/dense-cap tests below — the ref's real 13-group static
// taxonomy, reached the same way `page.tsx` reaches it on a taxonomy-load failure.
const FALLBACK_V2: V2Taxonomy = toV2Taxonomy(EMPTY_TAXONOMY);

describe('filterGroups', () => {
  it('returns all 13 groups unchanged for an empty query', () => {
    const result = filterGroups(FALLBACK_V2, '');
    expect(result).toEqual(FALLBACK_V2.groups);
    expect(result).toHaveLength(13);
  });

  it('filters items by name, case-insensitive', () => {
    const result = filterGroups(FALLBACK_V2, 'CLOUD');
    const salesCloudGroup = result.find((g) => g.group === 'Sales Cloud');
    expect(salesCloudGroup?.items.map((i) => i.name)).toEqual(['Sales Cloud']);
  });

  it('keeps a group whose GROUP NAME matches while none of its items do, with empty items', () => {
    // 'Marketing Cloud' group's items (Account Engagement, Engagement, Intelligence,
    // Loyalty Management, Personalisation) contain no "cloud" — only the group label does.
    const result = filterGroups(FALLBACK_V2, 'cloud');
    const marketingCloudGroup = result.find((g) => g.group === 'Marketing Cloud');
    expect(marketingCloudGroup).toBeDefined();
    expect(marketingCloudGroup?.items).toEqual([]);
  });

  it('returns [] when nothing matches — drives the "No products match" empty state', () => {
    expect(filterGroups(FALLBACK_V2, 'zzz')).toEqual([]);
  });
});

describe('visibleItems', () => {
  const denseGroup = FALLBACK_V2.groups.find((g) => g.group === 'Marketing Cloud');
  if (!denseGroup) throw new Error('fixture missing the "Marketing Cloud" group');

  it('caps a dense group (> DENSE_CAP items) at DENSE_CAP when collapsed', () => {
    expect(denseGroup.items.length).toBeGreaterThan(DENSE_CAP);
    const result = visibleItems(denseGroup, { expanded: false, query: '' });
    expect(result.show).toHaveLength(DENSE_CAP);
    expect(result.hidden).toBe(denseGroup.items.length - DENSE_CAP);
  });

  it('does not apply the dense cap while a query is active', () => {
    const result = visibleItems(denseGroup, { expanded: false, query: 'engagement' });
    expect(result.show).toHaveLength(denseGroup.items.length);
    expect(result.hidden).toBe(0);
  });

  it('shows every item when expanded', () => {
    const result = visibleItems(denseGroup, { expanded: true, query: '' });
    expect(result.show).toHaveLength(denseGroup.items.length);
    expect(result.hidden).toBe(0);
  });

  it('does not cap a group at or under DENSE_CAP', () => {
    const smallGroup = FALLBACK_V2.groups.find((g) => g.group === 'AI');
    if (!smallGroup) throw new Error('fixture missing the "AI" group');
    const result = visibleItems(smallGroup, { expanded: false, query: '' });
    expect(result.show).toEqual(smallGroup.items);
    expect(result.hidden).toBe(0);
  });
});

describe('facetSummary', () => {
  it('returns "Any" for no selection', () => {
    expect(facetSummary([])).toBe('Any');
  });

  it('returns the bare name for a single selection', () => {
    expect(facetSummary(['Sales Cloud'])).toBe('Sales Cloud');
  });

  it('returns "{first} +{n-1}" for multiple selections, as an if-chain (not a nested ternary)', () => {
    expect(facetSummary(['Sales Cloud', 'CPQ', 'Data Cloud'])).toBe('Sales Cloud +2');
  });
});

describe('itemKey', () => {
  it('uses the product id when present', () => {
    expect(itemKey({ id: 'prod-1', name: 'Sales Cloud' })).toBe('prod-1');
  });

  it('falls back to the name when id is null (fallback-mode items)', () => {
    expect(itemKey({ id: null, name: 'Sales Cloud' })).toBe('Sales Cloud');
  });
});

describe('selectedProductIds', () => {
  const TAXONOMY: V2Taxonomy = {
    source: 'live',
    groups: [
      {
        group: 'G',
        items: [
          { id: 'id-a', name: 'A' },
          { id: 'id-b', name: 'B' },
          { id: null, name: 'Fallback item' },
        ],
      },
    ],
  };

  it('drops null-id keys', () => {
    const keys = new Set(['id-a', 'Fallback item']);
    expect(selectedProductIds(keys, TAXONOMY)).toEqual(['id-a']);
  });

  it('preserves Set insertion (selection) order', () => {
    const keys = new Set(['id-b', 'id-a']);
    expect(selectedProductIds(keys, TAXONOMY)).toEqual(['id-b', 'id-a']);
  });

  it('ignores a key with no matching item', () => {
    const keys = new Set(['id-a', 'not-a-real-key']);
    expect(selectedProductIds(keys, TAXONOMY)).toEqual(['id-a']);
  });

  it('returns [] for an empty selection', () => {
    expect(selectedProductIds(new Set(), TAXONOMY)).toEqual([]);
  });
});
