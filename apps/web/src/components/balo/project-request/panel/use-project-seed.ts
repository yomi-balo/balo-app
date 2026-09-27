'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { flattenTaxonomyOptions, type ProductTaxonomy } from '@/lib/search/taxonomy';
import {
  freshDraftFields,
  hasOwnContent,
  isNewSearch,
  mergeSeedProductIds,
  seedProductsChanged,
  seedSearchText,
  seedTextPatch,
  type ProjectRequestSeed,
} from './project-seed';
import type { DraftSeedOrigin, FreshDraftFields, ProjectDraft } from './use-project-draft';

export interface UseProjectSeedOptions {
  open: boolean;
  seed?: ProjectRequestSeed;
  draft: ProjectDraft;
  setField: <K extends keyof ProjectDraft>(k: K, v: ProjectDraft[K]) => void;
  resetDraft: (fields: FreshDraftFields) => void;
  replaceDraft: (next: ProjectDraft) => void;
  /** The panel's LIVE products taxonomy (`taxonomies.products`) — used to filter seeded ids. */
  productsTaxonomy: ProductTaxonomy;
}

/** The in-panel offer to undo a new search's fresh start (`NewRequestNotice`). */
export interface NewRequestUndo {
  readonly onUndo: () => void;
  readonly onDismiss: () => void;
}

/** Seeded product ids awaiting the taxonomy, and the draft ids they are unioned into. */
interface PendingProducts {
  ids: readonly string[];
  /** `null` = the draft's own ids at apply time; `[]` = a fresh draft, so the seed's ids alone. */
  base: readonly string[] | null;
}

/** The draft a new search set aside, and the search that set it aside. */
interface SetAside {
  earlier: ProjectDraft;
  origin: DraftSeedOrigin | null;
}

/**
 * BAL-582 (§3b) — applies a hero seed to the draft ONCE PER OPEN. What the visitor typed in the
 * hero search bar takes precedence over the autosaved draft:
 *
 * - A NEW search (`isNewSearch`) starts a fresh request carrying only the seed — no earlier
 *   description, documents, products, budget or timeline — and records the search on the draft
 *   (`seededFrom`). When that set aside anything the visitor had added themselves
 *   (`hasOwnContent`), the hook returns an Undo offer for the panel to show INSIDE the drawer: a
 *   toast can't be clicked or reached from within the modal drawer.
 * - Any other seed CONTINUES the draft: `seedTextPatch` fills only blank text fields, so an edit
 *   made in the panel always survives, and the chips' products are unioned in only when the chips
 *   changed since the search that seeded the draft — so a product removed in the panel stays
 *   removed on a reopen.
 *
 * The Undo offer lapses when the panel closes, when it's dismissed, and while the fresh draft holds
 * anything the visitor added. Undo restores the earlier draft whole, re-pointed at the current
 * search so reopening with it continues the restored draft.
 *
 * Seeded product ids are held in a pending ref until the products taxonomy has actually loaded —
 * self-load or RSC-supplied, either path — then unioned with the draft's own ids (or, for a fresh
 * draft, used alone) and filtered to ids that exist in it (`mergeSeedProductIds`).
 *
 * Never sets `step` — that decision is `initialStepFor`'s, read once by the panel's own step
 * initialiser / open-reset effect.
 */
export function useProjectSeed({
  open,
  seed,
  draft,
  setField,
  resetDraft,
  replaceDraft,
  productsTaxonomy,
}: UseProjectSeedOptions): NewRequestUndo | null {
  const appliedRef = useRef(false);
  const pendingProductsRef = useRef<PendingProducts | null>(null);
  const [setAside, setSetAside] = useState<SetAside | null>(null);

  // Apply the seed once per open; stash any seeded product ids for the effect below.
  useEffect(() => {
    if (!open) {
      appliedRef.current = false;
      pendingProductsRef.current = null;
      setSetAside(null);
      return;
    }
    if (appliedRef.current) return;
    appliedRef.current = true;

    if (seed === undefined) return;
    const seedIds = seed.productIds ?? [];

    if (isNewSearch(draft, seed)) {
      const fresh = freshDraftFields(seed);
      resetDraft(fresh);
      pendingProductsRef.current = seedIds.length > 0 ? { ids: seedIds, base: [] } : null;
      if (hasOwnContent(draft)) setSetAside({ earlier: draft, origin: fresh.seededFrom });
      return;
    }

    const patch = seedTextPatch(draft, seed);
    if (patch.title !== undefined) setField('title', patch.title);
    if (patch.descriptionHtml !== undefined) setField('descriptionHtml', patch.descriptionHtml);
    if (seedProductsChanged(draft, seed)) {
      pendingProductsRef.current = seedIds.length > 0 ? { ids: seedIds, base: null } : null;
      setField('seededFrom', {
        text: draft.seededFrom?.text ?? seedSearchText(seed),
        productIds: [...seedIds],
      });
    } else if (draft.seededFrom === null && seedSearchText(seed) !== null) {
      setField('seededFrom', { text: seedSearchText(seed), productIds: [...seedIds] });
    }
  }, [open, seed, draft, setField, resetDraft]);

  // Apply pending product ids once the taxonomy has actually loaded (self-load or RSC-supplied).
  useEffect(() => {
    if (!open) return;
    const pending = pendingProductsRef.current;
    if (pending === null) return;
    if (productsTaxonomy.groups.length === 0) return;

    const liveIds = new Set(flattenTaxonomyOptions(productsTaxonomy).map((item) => item.id));
    const merged = mergeSeedProductIds(pending.base ?? draft.productIds, pending.ids, liveIds);
    pendingProductsRef.current = null;
    if (merged !== null) setField('productIds', merged);
  }, [open, productsTaxonomy, draft.productIds, setField]);

  const onUndo = useCallback(() => {
    if (setAside === null) return;
    // A taxonomy that loads AFTER the Undo must not write the new search's products over the
    // restored draft.
    pendingProductsRef.current = null;
    replaceDraft({ ...setAside.earlier, seededFrom: setAside.origin });
    setSetAside(null);
  }, [setAside, replaceDraft]);

  const onDismiss = useCallback(() => setSetAside(null), []);

  if (setAside === null || hasOwnContent(draft)) return null;
  return { onUndo, onDismiss };
}
