import { describe, it, expect } from 'vitest';
import {
  buildTaxonomyChoices,
  renderTaxonomyChoices,
  mapSlugsToIds,
  type TaxonomyChoice,
} from './taxonomy-mapping.js';
import type { ProjectTagsByGroup, ProductsByCategory } from '@balo/db';

describe('buildTaxonomyChoices', () => {
  it('flattens a tags-by-group read', () => {
    const groups: ProjectTagsByGroup[] = [
      {
        group: { id: 'g1', name: 'Group 1', slug: 'group-1', sortOrder: 0 },
        tags: [
          { id: 't1', name: 'Tag One', slug: 'tag-one', sortOrder: 0 },
          { id: 't2', name: 'Tag Two', slug: 'tag-two', sortOrder: 1 },
        ],
      },
    ];
    expect(buildTaxonomyChoices(groups)).toEqual([
      { slug: 'tag-one', id: 't1', name: 'Tag One' },
      { slug: 'tag-two', id: 't2', name: 'Tag Two' },
    ]);
  });

  it('flattens a products-by-category read', () => {
    const cats: ProductsByCategory[] = [
      {
        category: { id: 'c1', name: 'Cat 1', slug: 'cat-1', sortOrder: 0 },
        products: [{ id: 'p1', name: 'Product One', slug: 'product-one', sortOrder: 0 }],
      },
    ];
    expect(buildTaxonomyChoices(cats)).toEqual([
      { slug: 'product-one', id: 'p1', name: 'Product One' },
    ]);
  });

  it('empty input yields empty choices', () => {
    expect(buildTaxonomyChoices([])).toEqual([]);
  });
});

describe('renderTaxonomyChoices', () => {
  it('renders `slug — name` per line', () => {
    const choices: TaxonomyChoice[] = [
      { slug: 'a', id: '1', name: 'Alpha' },
      { slug: 'b', id: '2', name: 'Beta' },
    ];
    expect(renderTaxonomyChoices(choices)).toBe('a — Alpha\nb — Beta');
  });
});

describe('mapSlugsToIds', () => {
  const choices: TaxonomyChoice[] = [
    { slug: 'data-migration', id: 'id-1', name: 'Data Migration' },
    { slug: 'integration', id: 'id-2', name: 'Integration' },
  ];

  it('exact match resolves to the id', () => {
    expect(mapSlugsToIds(['data-migration'], choices)).toEqual({
      ids: ['id-1'],
      unmatchedSlugs: [],
    });
  });

  it('is case- and whitespace-tolerant', () => {
    expect(mapSlugsToIds(['  Data-Migration  ', 'INTEGRATION'], choices)).toEqual({
      ids: expect.arrayContaining(['id-1', 'id-2']),
      unmatchedSlugs: [],
    });
  });

  it('de-duplicates repeated matches', () => {
    const result = mapSlugsToIds(['data-migration', 'data-migration'], choices);
    expect(result.ids).toEqual(['id-1']);
  });

  it('drops an unknown slug, reporting it as unmatched', () => {
    expect(mapSlugsToIds(['sandbox-refresh'], choices)).toEqual({
      ids: [],
      unmatchedSlugs: ['sandbox-refresh'],
    });
  });

  it('empty input yields empty output', () => {
    expect(mapSlugsToIds([], choices)).toEqual({ ids: [], unmatchedSlugs: [] });
  });

  it('never returns an id outside the supplied choices (the D5 belt)', () => {
    const result = mapSlugsToIds(['data-migration', 'ghost'], choices);
    const liveIds = new Set(choices.map((c) => c.id));
    for (const id of result.ids) {
      expect(liveIds.has(id)).toBe(true);
    }
  });
});
