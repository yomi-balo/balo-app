/**
 * BAL-510 — pure model for the /v2 hero's Product facet popover.
 *
 * Ports the ref's `ProductFacet` inline logic (ref :894-997) into named, unit-tested
 * functions. Two reasons this is split out rather than left inline in the component:
 *
 * - `sonarjs/no-nested-conditional` (S3358) is an error in the diff-scoped sonar
 *   ruleset; the ref's facet summary (ref :898-899) is a nested ternary. `facetSummary`
 *   below is the same logic as an `if` chain.
 * - `sonarjs/cognitive-complexity <= 15` is diff-scoped and a brand-new file is fully
 *   exposed; hoisting `filterGroups` / `visibleItems` / `facetSummary` / `itemKey` out
 *   of the component keeps its render well under the limit.
 *
 * Pure: no React, no client directive. The only app import is a `import type` of
 * `ProductTaxonomy` — never a value import — so this module can never pull `@balo/db`
 * into the client bundle (the repo's `@balo/db` client-bundle footgun).
 */

import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import { DENSE_CAP, FALLBACK_TAXONOMY } from './content';

export interface V2TaxonomyItem {
  /** Product UUID when sourced from the live taxonomy; `null` in fallback mode. */
  id: string | null;
  name: string;
}

export interface V2TaxonomyGroup {
  group: string;
  items: V2TaxonomyItem[];
}

export interface V2Taxonomy {
  groups: V2TaxonomyGroup[];
  /** `'live'` when the DB-backed taxonomy returned groups; `'fallback'` otherwise (O1). */
  source: 'live' | 'fallback';
}

/**
 * Map the live `ProductTaxonomy` to the V2 shape, degrading to the ref's static
 * `FALLBACK_TAXONOMY` (every item `id: null`) when the live load returned no groups.
 * `loadSearchTaxonomy()` never throws — it already catches and returns `{ groups: [] }`
 * on failure — so `groups.length === 0` is the one degradation signal to key on.
 */
export function toV2Taxonomy(live: ProductTaxonomy): V2Taxonomy {
  if (live.groups.length > 0) {
    return {
      groups: live.groups.map((group) => ({
        group: group.name,
        items: group.items.map(({ id, name }) => ({ id, name })),
      })),
      source: 'live',
    };
  }
  return {
    groups: FALLBACK_TAXONOMY.map((group) => ({
      group: group.group,
      items: group.items.map((name) => ({ id: null, name })),
    })),
    source: 'fallback',
  };
}

/**
 * Selection-state key for an item — the live product UUID, or the bare name in
 * fallback mode (where every `id` is `null`). One state shape works in both modes.
 */
export function itemKey(item: V2TaxonomyItem): string {
  return item.id ?? item.name;
}

/**
 * Filter groups by item name (case-insensitive substring), ref :900-907. A group
 * whose name matches but whose items don't is kept with an empty `items` array —
 * the ref renders that as a label with no chips, and this preserves it.
 */
export function filterGroups(taxonomy: V2Taxonomy, query: string): V2TaxonomyGroup[] {
  if (query === '') return taxonomy.groups;
  const ql = query.toLowerCase();
  return taxonomy.groups
    .map((group) => ({
      group: group.group,
      items: group.items.filter((item) => item.name.toLowerCase().includes(ql)),
    }))
    .filter((group) => group.items.length > 0 || group.group.toLowerCase().includes(ql));
}

export interface VisibleItemsOptions {
  expanded: boolean;
  query: string;
}

export interface VisibleItemsResult {
  show: V2TaxonomyItem[];
  hidden: number;
}

/**
 * Dense-cap a group's chip list (ref :957-959): capped at `DENSE_CAP` unless the
 * group is expanded or a search query is active (a query already narrows the list,
 * so re-capping it on top would hide a match).
 */
export function visibleItems(
  group: V2TaxonomyGroup,
  options: VisibleItemsOptions
): VisibleItemsResult {
  const dense = group.items.length > DENSE_CAP && options.query === '';
  const show = dense && !options.expanded ? group.items.slice(0, DENSE_CAP) : group.items;
  return { show, hidden: group.items.length - show.length };
}

/**
 * Selected-chip summary shown in the facet trigger (ref :898-899), as an `if` chain
 * rather than a nested ternary — `sonarjs/no-nested-conditional` (S3358) is an error
 * in the diff-scoped sonar ruleset.
 */
export function facetSummary(names: string[]): string {
  if (names.length === 0) return 'Any';
  const [first] = names;
  if (first === undefined) return 'Any';
  if (names.length === 1) return first;
  return `${first} +${names.length - 1}`;
}

/**
 * Resolve selected chip keys back to product UUIDs, in selection order, dropping
 * fallback-mode keys (which carry no real id). `Set` iteration order is insertion
 * order, so this preserves the `"{first} +{n-1}"` summary's ordering by construction.
 */
export function selectedProductIds(
  selectedKeys: ReadonlySet<string>,
  taxonomy: V2Taxonomy
): string[] {
  const itemsByKey = new Map<string, V2TaxonomyItem>();
  for (const group of taxonomy.groups) {
    for (const item of group.items) {
      itemsByKey.set(itemKey(item), item);
    }
  }
  const ids: string[] = [];
  for (const key of selectedKeys) {
    const item = itemsByKey.get(key);
    if (item?.id != null) ids.push(item.id);
  }
  return ids;
}
