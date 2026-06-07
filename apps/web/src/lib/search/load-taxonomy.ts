import 'server-only';
import { referenceDataRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { mapProductsByCategoryToTaxonomy, EMPTY_TAXONOMY, type ProductTaxonomy } from './taxonomy';

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
    const vertical = await referenceDataRepository.getSalesforceVertical();
    const categories = await referenceDataRepository.getProductsByVertical(vertical.id);
    return mapProductsByCategoryToTaxonomy(categories);
  } catch (error) {
    log.error('Search taxonomy load failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return EMPTY_TAXONOMY;
  }
}
