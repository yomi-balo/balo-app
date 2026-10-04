import { describe, it, expect } from 'vitest';
import {
  buildTaxonomyChoices,
  renderTaxonomyChoices,
  mapSlugsToIds,
  deriveUnmatchedLabels,
  buildProductChoices,
  buildProductLabelIndex,
  resolveLabelsToProducts,
  type TaxonomyChoice,
} from './taxonomy-mapping.js';
import { MAX_UNMATCHED_LABELS, MAX_UNMATCHED_LABEL_LENGTH } from '@balo/shared/project-requests';
import type { ProjectTagsByGroup, ProductsForBriefMapping } from '@balo/db';

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
      { slug: 'tag-one', id: 't1', name: 'Tag One', group: 'Group 1' },
      { slug: 'tag-two', id: 't2', name: 'Tag Two', group: 'Group 1' },
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

describe('renderTaxonomyChoices (grouped)', () => {
  it('emits each group header once, and full lines with hint, includes and also-called', () => {
    const choices: TaxonomyChoice[] = [
      {
        slug: 'engagement',
        id: '1',
        name: 'Engagement',
        group: 'Marketing Cloud',
        hint: 'Messaging',
        includes: ['Journey Builder', 'Email Studio'],
        alsoCalled: ['ExactTarget'],
      },
      { slug: 'pardot', id: '2', name: 'Pardot', group: 'Marketing Cloud', includes: [] },
      { slug: 'sales', id: '3', name: 'Sales', group: 'Sales Cloud' },
    ];
    expect(renderTaxonomyChoices(choices)).toBe(
      [
        '[Marketing Cloud]',
        'engagement — Engagement | Messaging | includes: Journey Builder, Email Studio | also called: ExactTarget',
        'pardot — Pardot',
        '[Sales Cloud]',
        'sales — Sales',
      ].join('\n')
    );
  });

  it('writes no header for a choice without a group', () => {
    expect(renderTaxonomyChoices([{ slug: 'a', id: '1', name: 'Alpha' }])).toBe('a — Alpha');
  });
});

describe('buildProductChoices', () => {
  it('splits aliases by kind, carries the hint and group, and omits a null hint', () => {
    const groups: ProductsForBriefMapping[] = [
      {
        category: { id: 'c1', name: 'Marketing Cloud', slug: 'mc', sortOrder: 0 },
        products: [
          {
            id: 'p1',
            name: 'Engagement',
            slug: 'engagement',
            sortOrder: 0,
            aiHint: 'Messaging',
            aliases: [
              { alias: 'Journey Builder', kind: 'feature' },
              { alias: 'ExactTarget', kind: 'alt_name' },
            ],
          },
          { id: 'p2', name: 'Pardot', slug: 'pardot', sortOrder: 1, aiHint: null, aliases: [] },
        ],
      },
    ];
    const [first, second] = buildProductChoices(groups);
    expect(first).toEqual({
      slug: 'engagement',
      id: 'p1',
      name: 'Engagement',
      group: 'Marketing Cloud',
      hint: 'Messaging',
      includes: ['Journey Builder'],
      alsoCalled: ['ExactTarget'],
    });
    expect(second).not.toHaveProperty('hint');
  });
});

describe('product label resolution (BAL-592)', () => {
  const choices: TaxonomyChoice[] = [
    {
      slug: 'engagement',
      id: 'p-eng',
      name: 'Engagement',
      includes: ['Journey Builder'],
      alsoCalled: ['Marketing Cloud', 'Shared'],
    },
    { slug: 'pardot', id: 'p-pardot', name: 'Pardot', alsoCalled: ['Shared'] },
    { slug: 'shield', id: 'p-shield', name: 'Salesforce Shield' },
    { slug: 'energy', id: 'p-energy', name: 'Energy & Utilities Cloud' },
  ];
  const index = buildProductLabelIndex(choices);

  it('AC1: a feature label resolves to its product', () => {
    expect(resolveLabelsToProducts([], ['Journey Builder'], index)).toEqual({
      productIds: ['p-eng'],
      unresolvedSlugs: [],
      unresolvedLabels: [],
      resolvedCount: 1,
    });
  });

  it('AC2: a missed slug is humanised before lookup', () => {
    const result = resolveLabelsToProducts(['marketing-cloud'], [], index);
    expect(result.productIds).toEqual(['p-eng']);
    expect(result.unresolvedSlugs).toEqual([]);
  });

  it('AC3: the literal label "Salesforce Shield" resolves against a product named "Shield"', () => {
    const idx = buildProductLabelIndex([{ slug: 'shield', id: 'p-sh', name: 'Shield' }]);
    expect(resolveLabelsToProducts([], ['Salesforce Shield'], idx).productIds).toEqual(['p-sh']);
  });

  it('AC3: normalisation covers case, the Salesforce prefix and ampersands', () => {
    const result = resolveLabelsToProducts(
      [],
      ['PARDOT', 'Shield', 'Energy&Utilities  Cloud'],
      index
    );
    expect(result.productIds).toEqual(['p-pardot', 'p-shield', 'p-energy']);
  });

  it('AC5: an unknown label is returned unresolved, as given', () => {
    expect(resolveLabelsToProducts(['gong-io'], ['Gong'], index)).toEqual({
      productIds: [],
      unresolvedSlugs: ['gong-io'],
      unresolvedLabels: ['Gong'],
      resolvedCount: 0,
    });
  });

  it('a key claimed by two distinct products is ambiguous and never resolves', () => {
    expect(index.has('shared')).toBe(false);
    expect(resolveLabelsToProducts([], ['Shared'], index).unresolvedLabels).toEqual(['Shared']);
  });

  it('de-duplicates ids resolved from several strings', () => {
    const result = resolveLabelsToProducts(['marketing-cloud'], ['Journey Builder'], index);
    expect(result.productIds).toEqual(['p-eng']);
    expect(result.resolvedCount).toBe(2);
  });

  it('AC4: an alias of a product absent from the choices never resolves', () => {
    const live = buildProductLabelIndex(choices.filter((c) => c.id !== 'p-eng'));
    expect(resolveLabelsToProducts([], ['Journey Builder'], live).productIds).toEqual([]);
  });

  it('a match that would exceed the capacity is returned unresolved, selected ids keep priority', () => {
    const result = resolveLabelsToProducts(
      ['marketing-cloud'],
      ['Pardot', 'Journey Builder'],
      index,
      { selectedIds: new Set(['p-shield']), maxIds: 2 }
    );
    expect(result.productIds).toEqual(['p-eng']);
    expect(result.unresolvedSlugs).toEqual([]);
    expect(result.unresolvedLabels).toEqual(['Pardot']);
    expect(result.resolvedCount).toBe(2);
  });

  it('skips a key that normalises to empty', () => {
    const idx = buildProductLabelIndex([{ slug: 'x', id: '1', name: '  ', includes: ['&'] }]);
    expect(idx.has('')).toBe(false);
    expect(idx.get('and')).toBe('1');
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
