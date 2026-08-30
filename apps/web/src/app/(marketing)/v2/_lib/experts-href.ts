/**
 * BAL-510 — pure `/experts` URL builders for the /v2 preview.
 *
 * `buildExpertsHref` is a thin wrapper over the repo's own `/experts` URL contract
 * (`@/lib/search/filters`) so it cannot drift from what `/experts` itself parses (O1).
 * `resolveTickerHref` implements the ticket's O2 override: ticker items link straight
 * to a filtered `/experts` search rather than the ref's in-page anchor.
 *
 * Pure: no React, no client directive, no `@balo/db` (even by type — `filters.ts` and
 * `product-facet-model.ts`'s `V2Taxonomy` are both client-safe).
 */

import { EMPTY_FILTERS, serializeSearchFilters } from '@/lib/search/filters';
import type { V2Taxonomy } from './product-facet-model';

export interface BuildExpertsHrefInput {
  q: string;
  productIds: string[];
}

/**
 * Build an `/experts` href from a free-text query and selected product ids, reusing
 * `serializeSearchFilters` so `products` are repeated params (never comma-joined),
 * whitespace-only `q` is omitted, and every other filter stays at its default and is
 * therefore omitted too. Returns bare `/experts` (no trailing `?`) when both are empty.
 */
export function buildExpertsHref({ q, productIds }: BuildExpertsHrefInput): string {
  const params = serializeSearchFilters({ ...EMPTY_FILTERS, q, products: productIds });
  const query = params.toString();
  return query === '' ? '/experts' : `/experts?${query}`;
}

/**
 * Resolve a ticker label (ref :143-162) to an `/experts` href (O2). Exact full-name
 * match only, case-insensitive and whitespace-trimmed, over the taxonomy's flattened
 * items — never the group name (that would dissolve real distinctions, e.g. "Industry
 * Clouds" the group vs. an actual industry cloud product). No aliasing: a ref ticker
 * label with no matching product row (~5 of 18) intentionally falls through to a plain
 * `/experts`, and fallback-mode taxonomies (every `id: null`) always miss, since a
 * `null` id can't build a `products=` param.
 */
export function resolveTickerHref(label: string, taxonomy: V2Taxonomy): string {
  const target = label.trim().toLowerCase();
  for (const group of taxonomy.groups) {
    for (const item of group.items) {
      if (item.id !== null && item.name.trim().toLowerCase() === target) {
        return buildExpertsHref({ q: '', productIds: [item.id] });
      }
    }
  }
  return '/experts';
}
