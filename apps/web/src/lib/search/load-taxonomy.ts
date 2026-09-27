import 'server-only';
import { unstable_cache } from 'next/cache';
import { referenceDataRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { mapProductsByCategoryToTaxonomy, EMPTY_TAXONOMY, type ProductTaxonomy } from './taxonomy';

/** The two repository reads shared by the uncached and strict-cached loaders below. */
async function fetchTaxonomy(): Promise<ProductTaxonomy> {
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const categories = await referenceDataRepository.getProductsByVertical(vertical.id);
  return mapProductsByCategoryToTaxonomy(categories);
}

/**
 * Load the full browsable product taxonomy for the Search Composer (repo-direct,
 * no HTTP endpoint — mirrors the expert-apply `load-draft` precedent which also
 * reads `@balo/db` web-side).
 *
 * Degrades gracefully: on any failure it logs and returns an empty taxonomy so
 * `/experts` still renders (the ProductSelector shows an empty browse list and
 * the other facets — support/rate/availability/language — are unaffected). It
 * must NEVER throw and 500 the page.
 */
export async function loadSearchTaxonomy(): Promise<ProductTaxonomy> {
  try {
    return await fetchTaxonomy();
  } catch (error) {
    log.error('Search taxonomy load failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return EMPTY_TAXONOMY;
  }
}

/**
 * Strict variant for the cache below: throws instead of degrading, on either a
 * repository failure or an empty result (a `null`/empty vertical lookup), so
 * `unstable_cache` never stores a degraded taxonomy — a rejection can't be cached.
 */
async function fetchStrictSearchTaxonomy(): Promise<ProductTaxonomy> {
  const taxonomy = await fetchTaxonomy();
  if (taxonomy.groups.length === 0) {
    throw new Error('Search taxonomy empty');
  }
  return taxonomy;
}

/**
 * The taxonomy is public (not user-scoped) and changes only when admins edit the
 * catalogue, so one cache entry serves every visitor. 1 hour is a compromise between
 * freshness and the two-query cost on every uncached `/experts` render; there is no
 * `revalidateTag` wiring yet (accepted gap — BAL-504).
 */
const getCachedSearchTaxonomy = unstable_cache(fetchStrictSearchTaxonomy, ['search-taxonomy-v1'], {
  revalidate: 60 * 60,
  tags: ['search-taxonomy'],
});

/**
 * `/experts` should use this instead of {@link loadSearchTaxonomy} directly.
 * `unstable_cache` requires Next's request-scoped incremental-cache handler, absent
 * in a plain vitest process (and, rarely, in a misconfigured production cache
 * handler) — the fallback below degrades to the uncached, always-safe loader rather
 * than throwing and 500ing the page.
 */
export async function loadSearchTaxonomyCached(): Promise<ProductTaxonomy> {
  try {
    return await getCachedSearchTaxonomy();
  } catch (error) {
    log.warn('Search taxonomy cache unavailable; falling back to uncached read', {
      error: error instanceof Error ? error.message : String(error),
    });
    return loadSearchTaxonomy();
  }
}
