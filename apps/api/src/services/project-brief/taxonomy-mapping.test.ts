import { describe, it, expect } from 'vitest';
import {
  buildTaxonomyChoices,
  renderTaxonomyChoices,
  mapSlugsToIds,
  deriveUnmatchedLabels,
  type TaxonomyChoice,
} from './taxonomy-mapping.js';
import { MAX_UNMATCHED_LABELS, MAX_UNMATCHED_LABEL_LENGTH } from '@balo/shared/project-requests';
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

/**
 * BAL-254 W4 — the review footnote. `unmatchedSlugs` was computed and thrown away while the
 * persisted labels came straight from the model's self-report, so a slug that missed the live
 * taxonomy and was not self-reported vanished silently.
 */
describe('deriveUnmatchedLabels', () => {
  it('⚠ surfaces a slug that missed the taxonomy even when the model reported nothing', () => {
    expect(deriveUnmatchedLabels(['crm-analytics'], [])).toEqual(['Crm analytics']);
  });

  it("keeps the model's self-reported labels — a concept with no slug emits nothing under source 1", () => {
    expect(deriveUnmatchedLabels([], ['Sandbox refresh'])).toEqual(['Sandbox refresh']);
  });

  it('unions both sources, mapping failures first', () => {
    expect(deriveUnmatchedLabels(['crm-analytics'], ['Sandbox refresh'])).toEqual([
      'Crm analytics',
      'Sandbox refresh',
    ]);
  });

  it('de-duplicates case-insensitively across the two sources', () => {
    expect(deriveUnmatchedLabels(['crm-analytics'], ['crm analytics', 'CRM Analytics'])).toEqual([
      'Crm analytics',
    ]);
  });

  it('de-slugs separators into single spaces', () => {
    expect(deriveUnmatchedLabels(['marketing_cloud--personalization'], [])).toEqual([
      'Marketing cloud personalization',
    ]);
  });

  it('drops a slug that de-slugs to nothing', () => {
    expect(deriveUnmatchedLabels(['---', '  '], [])).toEqual([]);
  });

  it(`bounds every label to ${MAX_UNMATCHED_LABEL_LENGTH} characters`, () => {
    const [derived] = deriveUnmatchedLabels(['a'.repeat(200)], []);
    const [reported] = deriveUnmatchedLabels([], ['b'.repeat(200)]);
    expect(derived).toHaveLength(MAX_UNMATCHED_LABEL_LENGTH);
    expect(reported).toHaveLength(MAX_UNMATCHED_LABEL_LENGTH);
  });

  it(`bounds the list to ${MAX_UNMATCHED_LABELS} labels`, () => {
    const slugs = Array.from({ length: 12 }, (_, i) => `slug-${i}`);
    const reported = Array.from({ length: 12 }, (_, i) => `Reported ${i}`);
    expect(deriveUnmatchedLabels(slugs, reported)).toHaveLength(MAX_UNMATCHED_LABELS);
  });

  it('empty in, empty out', () => {
    expect(deriveUnmatchedLabels([], [])).toEqual([]);
  });
});
