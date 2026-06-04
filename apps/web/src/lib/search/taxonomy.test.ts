import { describe, it, expect } from 'vitest';
import type { SkillsByCategory } from '@balo/db';
import {
  buildProductNameMap,
  flattenTaxonomyOptions,
  mapSkillsByCategoryToTaxonomy,
  EMPTY_TAXONOMY,
  type ProductTaxonomy,
} from './taxonomy';

function category(
  id: string,
  name: string,
  skills: Array<{ id: string; name: string }>
): SkillsByCategory {
  return {
    category: { id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), sortOrder: 0 },
    skills: skills.map((s, i) => ({ id: s.id, name: s.name, slug: s.name, sortOrder: i })),
  };
}

const taxonomy: ProductTaxonomy = {
  groups: [
    { id: 'g1', name: 'AI', items: [{ id: 'a1', name: 'Agentforce' }] },
    {
      id: 'g2',
      name: 'Industries',
      items: [
        { id: 'i1', name: 'Health Cloud' },
        { id: 'i2', name: 'Financial Services Cloud' },
      ],
    },
  ],
};

describe('mapSkillsByCategoryToTaxonomy', () => {
  it('maps categories to groups and skills to items keyed by UUID', () => {
    const result = mapSkillsByCategoryToTaxonomy([
      category('cat-ai', 'AI', [{ id: 'sk-agent', name: 'Agentforce' }]),
      category('cat-ind', 'Industries', [{ id: 'sk-health', name: 'Health Cloud' }]),
    ]);
    expect(result).toEqual({
      groups: [
        { id: 'cat-ai', name: 'AI', items: [{ id: 'sk-agent', name: 'Agentforce' }] },
        { id: 'cat-ind', name: 'Industries', items: [{ id: 'sk-health', name: 'Health Cloud' }] },
      ],
    });
  });

  it('returns an empty groups list for no categories', () => {
    expect(mapSkillsByCategoryToTaxonomy([])).toEqual(EMPTY_TAXONOMY);
  });
});

describe('buildProductNameMap', () => {
  it('maps every skill id to its name across all groups (including Industries)', () => {
    expect(buildProductNameMap(taxonomy)).toEqual({
      a1: 'Agentforce',
      i1: 'Health Cloud',
      i2: 'Financial Services Cloud',
    });
  });

  it('returns an empty map for an empty taxonomy', () => {
    expect(buildProductNameMap(EMPTY_TAXONOMY)).toEqual({});
  });

  it('does not contain ids that are not in the taxonomy (caller must fall back)', () => {
    const map = buildProductNameMap(taxonomy);
    expect(map['unknown-id']).toBeUndefined();
  });
});

describe('flattenTaxonomyOptions', () => {
  it('flattens all items across groups in order', () => {
    expect(flattenTaxonomyOptions(taxonomy)).toEqual([
      { id: 'a1', name: 'Agentforce' },
      { id: 'i1', name: 'Health Cloud' },
      { id: 'i2', name: 'Financial Services Cloud' },
    ]);
  });

  it('returns an empty list for an empty taxonomy', () => {
    expect(flattenTaxonomyOptions(EMPTY_TAXONOMY)).toEqual([]);
  });
});
