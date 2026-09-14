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
  /**
   * ⚠⚠ "EMPTY" AND "FAILED" ARE NOT THE SAME ANSWER (BAL-254 fix round F17). This loader never
   * throws — it returns `EMPTY_TAXONOMY` for both on any error — which is right for the PICKER
   * (it shows its empty/error state with Retry) and wrong for anything that uses the taxonomy as
   * a FILTER: an empty live-id set silently intersects every id away.
   *
   * `true` means the read failed. A caller that filters against these ids MUST branch on it
   * rather than treating the empty result as "the taxonomy genuinely has nothing in it" — see
   * `actions/get-project-brief-parse.ts`, where a DB blip would otherwise have handed the client
   * a brief with every AI-selected tag and product quietly dropped and no signal at all.
   *
   * ⚠ OPTIONAL, and absent reads as "did not fail". This shape is also written as a literal by
   * RSC callers and by test fixtures that never went near the loader; making the flag required
   * would force every one of them to assert something they have no opinion about. The loader —
   * the only thing that can actually observe a failure — sets it explicitly on BOTH branches,
   * and `load-project-taxonomy.test.ts` pins that.
   */
  loadFailed?: boolean;
}

/**
 * Load both project-request taxonomies (tags + products) for the Salesforce
 * vertical. Mirrors `load-taxonomy.ts`: degrades gracefully — on ANY failure it
 * logs and returns EMPTY for both, so the drawer's picker shows its empty/error
 * state with Retry rather than the page throwing. Never throws — but it does now
 * SAY so, via `loadFailed`.
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
      loadFailed: false,
    };
  } catch (error) {
    log.error('Project taxonomy load failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { tags: EMPTY_TAXONOMY, products: EMPTY_TAXONOMY, loadFailed: true };
  }
}
