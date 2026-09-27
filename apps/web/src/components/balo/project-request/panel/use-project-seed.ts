'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
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
import { projectFunnelDimensions } from './funnel-dimensions';
import type { AiGeneratedState } from './use-ai-brief-flow';
import type {
  DraftSeedOrigin,
  FreshDraftFields,
  ProjectDraft,
  ProjectRequestEntryPoint,
} from './use-project-draft';

export interface UseProjectSeedOptions {
  open: boolean;
  seed?: ProjectRequestSeed;
  draft: ProjectDraft;
  setField: <K extends keyof ProjectDraft>(k: K, v: ProjectDraft[K]) => void;
  resetDraft: (fields: FreshDraftFields) => void;
  replaceDraft: (next: ProjectDraft) => void;
  /** The panel's LIVE products taxonomy (`taxonomies.products`) — used to filter seeded ids. */
  productsTaxonomy: ProductTaxonomy;
  /** `useAiBriefFlow`'s CURRENT generation state — read once, at the instant a fresh start would
   *  otherwise lose it, so it can be stashed in `SetAside` for Undo. `null` before any generate. */
  capturedAiState: AiGeneratedState | null;
  /** ⚠ Called ALONGSIDE `resetDraft` on a fresh start, never on its own — see `AiGeneratedState`'s
   *  docblock for the stale-state bug this closes. */
  clearAiState: () => void;
  /** ⚠ Called ALONGSIDE `replaceDraft` on Undo, with the SAME `SetAside` this hook captured. */
  restoreAiState: (state: AiGeneratedState | null) => void;
  /** BAL-582 (D2) — threaded into the notice's shown/undo/dismiss analytics dimensions. */
  expertProfileId: string | undefined;
  entryPoint: ProjectRequestEntryPoint;
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

/** The draft a new search set aside, the search that set it aside, and any AI generation state
 *  captured at that same moment — restored together on Undo (`AiGeneratedState`'s docblock). */
interface SetAside {
  earlier: ProjectDraft;
  origin: DraftSeedOrigin | null;
  aiState: AiGeneratedState | null;
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
  capturedAiState,
  clearAiState,
  restoreAiState,
  expertProfileId,
  entryPoint,
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
      // ⚠⚠ ALONGSIDE `resetDraft`, NEVER ON ITS OWN — see `AiGeneratedState`'s docblock. Without
      // this, `useAiBriefFlow`'s snapshot/hints/edited-fields survive the reset and can re-arm on
      // the fresh draft the moment it walks back to `source: 'ai'` (e.g. "Change entry method" →
      // "Upload docs" on the SAME fresh request, before any new generate).
      clearAiState();
      pendingProductsRef.current = seedIds.length > 0 ? { ids: seedIds, base: [] } : null;
      if (hasOwnContent(draft)) {
        // Captured BEFORE `clearAiState` above takes visible effect — `capturedAiState` here is
        // this render's (pre-clear) value, exactly the generation the fresh start is setting aside.
        setSetAside({ earlier: draft, origin: fresh.seededFrom, aiState: capturedAiState });
        track(PROJECT_EVENTS.PROJECT_NEW_REQUEST_NOTICE_SHOWN, {
          ...projectFunnelDimensions(expertProfileId, entryPoint),
        });
      }
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
  }, [
    open,
    seed,
    draft,
    setField,
    resetDraft,
    clearAiState,
    capturedAiState,
    expertProfileId,
    entryPoint,
  ]);

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
    track(PROJECT_EVENTS.PROJECT_NEW_REQUEST_UNDO_CLICKED, {
      ...projectFunnelDimensions(expertProfileId, entryPoint),
    });
    // A taxonomy that loads AFTER the Undo must not write the new search's products over the
    // restored draft.
    pendingProductsRef.current = null;
    replaceDraft({ ...setAside.earlier, seededFrom: setAside.origin });
    // Restores the SAME generation `clearAiState` cleared when this SetAside was captured — see
    // `AiGeneratedState`'s docblock.
    restoreAiState(setAside.aiState);
    setSetAside(null);
  }, [setAside, replaceDraft, restoreAiState, expertProfileId, entryPoint]);

  const onDismiss = useCallback(() => {
    track(PROJECT_EVENTS.PROJECT_NEW_REQUEST_DISMISSED, {
      ...projectFunnelDimensions(expertProfileId, entryPoint),
    });
    setSetAside(null);
  }, [expertProfileId, entryPoint]);

  if (setAside === null || hasOwnContent(draft)) return null;
  return { onUndo, onDismiss };
}
