import 'server-only';

import { referenceDataRepository } from '@balo/db';
import { log } from '@/lib/logging';
import {
  mapProductsByCategoryToTaxonomy,
  mapProjectTagsByGroupToTaxonomy,
  EMPTY_TAXONOMY,
  type ProductTaxonomy,
} from '@/lib/search/taxonomy';

export interface ProjectRequestTaxonomies {
  /** Project-type tags grouped by tag group (mapped to the shared taxonomy shape). */
  tags: ProductTaxonomy;
  /** Salesforce products grouped by category (reuses the existing mapper). */
  products: ProductTaxonomy;
}

/**
 * Load both project-request taxonomies (tags + products) for the Salesforce
 * vertical. Mirrors `load-taxonomy.ts`: degrades gracefully — on ANY failure it
 * logs and returns EMPTY for both, so the drawer's picker shows its empty/error
 * state with Retry rather than the page throwing. Never throws.
 */
export async function loadProjectRequestTaxonomies(): Promise<ProjectRequestTaxonomies> {
  try {
    const vertical = await referenceDataRepository.getSalesforceVertical();
    const [tagGroups, productCats] = await Promise.all([
      referenceDataRepository.getProjectTagsByVertical(vertical.id),
      referenceDataRepository.getProductsByVertical(vertical.id),
    ]);
    return {
      tags: mapProjectTagsByGroupToTaxonomy(tagGroups),
      products: mapProductsByCategoryToTaxonomy(productCats),
    };
  } catch (error) {
    log.error('Project taxonomy load failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { tags: EMPTY_TAXONOMY, products: EMPTY_TAXONOMY };
  }
}
