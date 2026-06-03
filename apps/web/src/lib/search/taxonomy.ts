/**
 * Pure types + helpers for the Search Composer's browsable product taxonomy.
 *
 * The taxonomy is the full, browsable set of skills grouped by skill category
 * (13 categories / 39 skills, including an "Industries" category). It is the
 * authoritative id→name source for the ProductSelector tokens and for analytics
 * product-name arrays — the API's `facetCounts` only covers the supply-gated
 * subset, so it cannot label zero-supply selections.
 *
 * IMPORTANT: the "Industries" group is a `skill_category` whose item ids are
 * skill UUIDs that write into `SearchFilters.products[]`. It is NOT the API's
 * separate `industries[]` filter — do not wire the two together.
 *
 * No React, no fetch — pure functions so it is trivially unit-testable.
 */

import type { SkillsByCategory } from '@balo/db';

export interface TaxonomyItem {
  /** Skill UUID — written into `SearchFilters.products[]`. */
  id: string;
  name: string;
}

export interface TaxonomyGroup {
  /** Skill-category UUID. */
  id: string;
  name: string;
  items: TaxonomyItem[];
}

export interface ProductTaxonomy {
  groups: TaxonomyGroup[];
}

export const EMPTY_TAXONOMY: ProductTaxonomy = { groups: [] };

/**
 * Map the repository's `SkillsByCategory[]` shape to the client `ProductTaxonomy`.
 * Each category becomes a group; each skill becomes an item keyed by its UUID.
 */
export function mapSkillsByCategoryToTaxonomy(categories: SkillsByCategory[]): ProductTaxonomy {
  return {
    groups: categories.map((cat) => ({
      id: cat.category.id,
      name: cat.category.name,
      items: cat.skills.map((s) => ({ id: s.id, name: s.name })),
    })),
  };
}

/**
 * Build a skill id → name lookup across all groups. Used for selected-token
 * labels and analytics product-name arrays. Authoritative over `facetCounts`
 * because it includes zero-supply skills.
 */
export function buildProductNameMap(taxonomy: ProductTaxonomy): Record<string, string> {
  const map: Record<string, string> = {};
  for (const group of taxonomy.groups) {
    for (const item of group.items) {
      map[item.id] = item.name;
    }
  }
  return map;
}

/** Flatten the taxonomy to a single id/name list (search + count helpers). */
export function flattenTaxonomyOptions(taxonomy: ProductTaxonomy): TaxonomyItem[] {
  return taxonomy.groups.flatMap((group) => group.items);
}
