'use client';

import { useEffect, useRef } from 'react';
import { flattenTaxonomyOptions, type ProductTaxonomy } from '@/lib/search/taxonomy';
import { mergeSeedProductIds, seedTextPatch, type ProjectRequestSeed } from './project-seed';
import type { ProjectDraft } from './use-project-draft';

export interface UseProjectSeedOptions {
  open: boolean;
  seed?: ProjectRequestSeed;
  draft: ProjectDraft;
  setField: <K extends keyof ProjectDraft>(k: K, v: ProjectDraft[K]) => void;
  /** The panel's LIVE products taxonomy (`taxonomies.products`) — used to filter seeded ids. */
  productsTaxonomy: ProductTaxonomy;
}

/**
 * BAL-582 (§3b) — applies a hero seed to the draft ONCE PER OPEN. Text fields (title,
 * description) are filled synchronously at open, via the pure `seedTextPatch` (which already
 * refuses to overwrite anything the draft holds). Seeded product ids are held in a pending ref
 * until the products taxonomy has actually loaded — self-load or RSC-supplied, either path — then
 * unioned with the draft's own ids and filtered to ids that exist in it (`mergeSeedProductIds`).
 *
 * Never sets `step` — that decision is `initialStepFor`'s, read once by the panel's own step
 * initialiser / open-reset effect.
 */
export function useProjectSeed({
  open,
  seed,
  draft,
  setField,
  productsTaxonomy,
}: UseProjectSeedOptions): void {
  const appliedRef = useRef(false);
  const pendingProductIdsRef = useRef<readonly string[] | null>(null);

  // Apply text fields once per open; stash any seeded product ids for the effect below.
  useEffect(() => {
    if (!open) {
      appliedRef.current = false;
      pendingProductIdsRef.current = null;
      return;
    }
    if (appliedRef.current) return;
    appliedRef.current = true;

    if (seed === undefined) return;

    const patch = seedTextPatch(draft, seed);
    if (patch.title !== undefined) setField('title', patch.title);
    if (patch.descriptionHtml !== undefined) setField('descriptionHtml', patch.descriptionHtml);

    if (seed.productIds !== undefined && seed.productIds.length > 0) {
      pendingProductIdsRef.current = seed.productIds;
    }
  }, [open, seed, draft, setField]);

  // Apply pending product ids once the taxonomy has actually loaded (self-load or RSC-supplied).
  useEffect(() => {
    if (!open) return;
    const pending = pendingProductIdsRef.current;
    if (pending === null) return;
    if (productsTaxonomy.groups.length === 0) return;

    const liveIds = new Set(flattenTaxonomyOptions(productsTaxonomy).map((item) => item.id));
    const merged = mergeSeedProductIds(draft.productIds, pending, liveIds);
    pendingProductIdsRef.current = null;
    if (merged !== null) setField('productIds', merged);
  }, [open, productsTaxonomy, draft.productIds, setField]);
}
