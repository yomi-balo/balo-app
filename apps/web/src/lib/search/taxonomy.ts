/**
 * Pure types + helpers for the Search Composer's browsable product taxonomy.
 *
 * The taxonomy is the full, browsable set of products grouped by category
 * (13 categories / 39 products, including an "Industry Clouds" category). It is the
 * authoritative id→name source for the ProductSelector tokens and for analytics
 * product-name arrays — the API's `facetCounts` only covers the supply-gated
 * subset, so it cannot label zero-supply selections.
 *
 * IMPORTANT: the "Industry Clouds" group is a `category` whose item ids are
 * product UUIDs that write into `SearchFilters.products[]`. It is NOT the API's
 * separate `industries[]` filter — do not wire the two together.
 *
 * No React, no fetch — pure functions so it is trivially unit-testable.
 */

import type { ProductsByCategory, ProjectTagsByGroup } from '@balo/db';

export interface TaxonomyItem {
  /** Product UUID — written into `SearchFilters.products[]`. */
  id: string;
  name: string;
}

export interface TaxonomyGroup {
  /** Category UUID. */
  id: string;
  name: string;
  items: TaxonomyItem[];
}

export interface ProductTaxonomy {
  groups: TaxonomyGroup[];
}

export const EMPTY_TAXONOMY: ProductTaxonomy = { groups: [] };

/**
 * Map the repository's `ProductsByCategory[]` shape to the client `ProductTaxonomy`.
 * Each category becomes a group; each product becomes an item keyed by its UUID.
 */
export function mapProductsByCategoryToTaxonomy(categories: ProductsByCategory[]): ProductTaxonomy {
  return {
    groups: categories.map((cat) => ({
      id: cat.category.id,
      name: cat.category.name,
      items: cat.products.map((s) => ({ id: s.id, name: s.name })),
    })),
  };
}

/**
 * Map the repository's `ProjectTagsByGroup[]` shape to the client `ProductTaxonomy`.
 * Each tag group becomes a group; each tag becomes an item keyed by its UUID.
 *
 * The `ProductTaxonomy` shape is intentionally reused (groups[].items[]) so the
 * picker is taxonomy-shape-agnostic — it renders tags and products identically.
 */
export function mapProjectTagsByGroupToTaxonomy(groups: ProjectTagsByGroup[]): ProductTaxonomy {
  return {
    groups: groups.map((g) => ({
      id: g.group.id,
      name: g.group.name,
      items: g.tags.map((t) => ({ id: t.id, name: t.name })),
    })),
  };
}

/**
 * Build a product id → name lookup across all groups. Used for selected-token
 * labels and analytics product-name arrays. Authoritative over `facetCounts`
 * because it includes zero-supply products.
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
