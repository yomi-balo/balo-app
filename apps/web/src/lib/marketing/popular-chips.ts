import 'server-only';
import { log } from '@/lib/logging';
import { flattenTaxonomyOptions, type ProductTaxonomy } from '@/lib/search/taxonomy';

/**
 * BAL-493 §4.2 — the 7 hero "popular" chip names. All seven are EXACT, live taxonomy
 * product names (verified against `packages/db/src/seed.ts`'s `PRODUCT_CATEGORIES`).
 */
export const POPULAR_CHIP_PRODUCTS = [
  'Agentforce',
  'Data Cloud',
  'CPQ',
  'Sales Cloud',
  'Service Cloud',
  'MuleSoft',
  'Tableau',
] as const;

export interface PopularChip {
  id: string;
  name: string;
}

/**
 * Resolve the declared chip names against the live taxonomy → `{id,name}[]`, in the
 * declared order. A chip whose name has no taxonomy match is DROPPED and logged
 * (`log.warn`) — never silently, because a silent drop is how a taxonomy rename goes
 * unnoticed for a quarter. Rendering it would produce a chip that can never match anything.
 */
export function resolvePopularChips(taxonomy: ProductTaxonomy): PopularChip[] {
  const nameToId = new Map<string, string>();
  for (const item of flattenTaxonomyOptions(taxonomy)) {
    if (!nameToId.has(item.name)) nameToId.set(item.name, item.id);
  }

  const chips: PopularChip[] = [];
  for (const name of POPULAR_CHIP_PRODUCTS) {
    const id = nameToId.get(name);
    if (id === undefined) {
      log.warn('Marketing chip has no taxonomy match', { name });
      continue;
    }
    chips.push({ id, name });
  }
  return chips;
}
