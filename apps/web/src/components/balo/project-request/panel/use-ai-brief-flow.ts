'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { track, PROJECT_EVENTS, type ProjectStep } from '@/lib/analytics';
import type { ProjectBriefDraftPatch } from '@/lib/project-request/actions/get-project-brief-parse';
import type { ProjectRequestEntryPoint } from '@balo/shared/project-requests';
import {
  useProjectBriefGeneration,
  reportUnexpectedBriefError,
} from './use-project-brief-generation';
import { projectFunnelDimensions } from './funnel-dimensions';
import type { ProjectDraft } from './use-project-draft';

/**
 * The four AI-owned fields, snapshotted immediately after a successful generate. Exported
 * (BAL-589) so `useCaseBriefFlow` — the case-history sibling of this flow — reuses the exact
 * same shape and comparison rather than redefining both.
 */
export interface AiFieldSnapshot {
  title: string;
  descriptionHtml: string;
  tagIds: string[];
  productIds: string[];
}

/** @see AiFieldSnapshot */
export function snapshotsDiffer(a: AiFieldSnapshot, b: AiFieldSnapshot): boolean {
  return (
    a.title !== b.title ||
    a.descriptionHtml !== b.descriptionHtml ||
    JSON.stringify(a.tagIds) !== JSON.stringify(b.tagIds) ||
    JSON.stringify(a.productIds) !== JSON.stringify(b.productIds)
  );
}

const NO_UNMATCHED: { tags: string[]; products: string[] } = { tags: [], products: [] };

/**
 * Everything an AI generation leaves behind that must survive a "set aside, then Undo" cycle
 * together: the snapshot `hasEditsSinceGenerate` compares against, the unmatched-label hints,
 * and which fields have already fired `PROJECT_AI_FIELDS_EDITED` (so re-editing a field after an
 * Undo doesn't double-fire it). A fresh start that ISN'T undone must clear all three together too
 * — see `clearAiState`.
 */
export interface AiGeneratedState {
  snapshot: AiFieldSnapshot;
  unmatchedLabels: { tags: string[]; products: string[] };
  editedFields: readonly string[];
}

export interface UseAiBriefFlowOptions {
  expertProfileId: string | undefined;
  /** BAL-582 (D2) — threaded into `PROJECT_ENTRY_SELECTED`'s `entry_point` dimension. */
  entryPoint: ProjectRequestEntryPoint;
  draft: ProjectDraft;
  setField: <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => void;
  setStep: (step: ProjectStep) => void;
  /**
   * ⚠⚠ THE ABANDONED-FLOW GUARD (fix round F5). False once the drawer is closed or the request
   * has been submitted (`step === 'done'`).
   *
   * Closing the drawer does NOT unmount `ProjectRequestPanel` — it only flips `open` — so the
   * polling interval keeps running, and a parse that lands afterwards would otherwise repopulate
   * the four AI fields over a just-cleared draft and yank the user back to `review` from the
   * confirmation screen. The panel owns the facts; this hook only has to be told.
   */
  isFlowActive: boolean;
}

export interface UseAiBriefFlowResult {
  briefGeneration: ReturnType<typeof useProjectBriefGeneration>;
  isGenerating: boolean;
  isUploadFailed: boolean;
  unmatchedLabels: { tags: string[]; products: string[] };
  hasEditsSinceGenerate: boolean;
  regenerateConfirmOpen: boolean;
  setRegenerateConfirmOpen: (open: boolean) => void;
  handleSelectAi: () => void;
  /**
   * ⚠ BAL-254 W2 — ABANDON any in-flight generation. The panel calls this from
   * `handleSelectManual` ("I'll write it myself" on the start step); this hook calls it itself
   * from {@link UseAiBriefFlowResult.handleWriteItMyself}. Both are "the user has left the AI
   * path", and a parse that lands afterwards must never write the four AI fields.
   */
  cancelGeneration: () => void;
  handleGenerateClick: () => void;
  handleRetryGenerate: () => void;
  handleWriteItMyself: () => void;
  handleRegenerateClick: () => void;
  handleConfirmRegenerate: () => void;
  /**
   * ⚠ The current generation's state, for a caller (`useProjectSeed`) to stash BEFORE a fresh
   * start clears it — the moment a new hero search sets a draft aside, so its Undo can bring the
   * AI brief back too. `null` before any successful generate.
   */
  capturedAiState: AiGeneratedState | null;
  /**
   * ⚠⚠ THE FIX FOR THE STALE-STATE BUG. `lastGeneratedSnapshot` / `unmatchedLabels` /
   * `editedFieldsFiredRef` used to last for the whole mount, gated only by `draft.source === 'ai'`
   * at each READ site — which covers a draft that STAYS manual, but not one that goes fresh
   * (`source` reset to `'manual'`) and is then walked back to `'ai'` on the SAME draft
   * (`handleSelectAi` from `start`, e.g. via "Change entry method"). That re-armed the OLD
   * generation's snapshot and hints over a draft nothing had been generated for yet. `useProjectSeed`
   * calls this at the exact moment it starts a fresh request (`resetDraft`), never on every render.
   */
  clearAiState: () => void;
  /** Restores a `capturedAiState` snapshot verbatim — `useProjectSeed`'s Undo, alongside
   *  `replaceDraft`. `null` clears, same as `clearAiState`. */
  restoreAiState: (state: AiGeneratedState | null) => void;
}

/**
 * BAL-254 — the AI brief path's state + handlers, extracted out of `ProjectRequestPanel` (whose
 * cognitive complexity exceeded the SonarCloud gate once this logic was inlined). Owns: the
 * polling hook, the Regenerate clobber-guard snapshot, the display-only unmatched-label state
 * (⚠ component state, NEVER `ProjectDraft` — never autosaves to localStorage), the regenerate
 * confirm-dialog flag, and every analytics fire site for this path.
 */
export function useAiBriefFlow({
  expertProfileId,
  entryPoint,
  draft,
  setField,
  setStep,
  isFlowActive,
}: UseAiBriefFlowOptions): UseAiBriefFlowResult {
  const { title, descriptionHtml, tagIds, productIds } = draft;
  const trimmedTitle = title.trim();

  // Read inside a callback that must NOT re-create itself on every open/step change.
  const isFlowActiveRef = useRef(isFlowActive);
  isFlowActiveRef.current = isFlowActive;

  // The four AI-owned fields as of the LAST successful generate (null before any generate).
  const [lastGeneratedSnapshot, setLastGeneratedSnapshot] = useState<AiFieldSnapshot | null>(null);
  const [unmatchedLabels, setUnmatchedLabels] = useState<{ tags: string[]; products: string[] }>(
    NO_UNMATCHED
  );
  const [regenerateConfirmOpen, setRegenerateConfirmOpen] = useState(false);
  const isRegenerateRef = useRef(false);
  const generateStartedAtRef = useRef<number | null>(null);
  const failureTrackedRef = useRef(false);
  const editedFieldsFiredRef = useRef<Set<string>>(new Set());

  const handleSelectAi = useCallback(() => {
    track(PROJECT_EVENTS.PROJECT_ENTRY_SELECTED, {
      ...projectFunnelDimensions(expertProfileId, entryPoint),
      method: 'ai',
    });
    setField('source', 'ai');
    setStep('upload');
  }, [expertProfileId, entryPoint, setField, setStep]);

  const currentAiSnapshot: AiFieldSnapshot = useMemo(
    () => ({ title: trimmedTitle, descriptionHtml, tagIds, productIds }),
    [trimmedTitle, descriptionHtml, tagIds, productIds]
  );
  const hasEditsSinceGenerate =
    lastGeneratedSnapshot !== null && snapshotsDiffer(lastGeneratedSnapshot, currentAiSnapshot);

  const capturedAiState: AiGeneratedState | null =
    lastGeneratedSnapshot === null
      ? null
      : {
          snapshot: lastGeneratedSnapshot,
          unmatchedLabels,
          editedFields: [...editedFieldsFiredRef.current],
        };

  const clearAiState = useCallback(() => {
    setLastGeneratedSnapshot(null);
    setUnmatchedLabels(NO_UNMATCHED);
    editedFieldsFiredRef.current = new Set();
  }, []);

  const restoreAiState = useCallback((state: AiGeneratedState | null) => {
    if (state === null) {
      setLastGeneratedSnapshot(null);
      setUnmatchedLabels(NO_UNMATCHED);
      editedFieldsFiredRef.current = new Set();
      return;
    }
    setLastGeneratedSnapshot(state.snapshot);
    setUnmatchedLabels(state.unmatchedLabels);
    editedFieldsFiredRef.current = new Set(state.editedFields);
  }, []);

  const handleGenerationSucceeded = useCallback(
    (patch: ProjectBriefDraftPatch) => {
      // ⚠⚠ FIX ROUND F5 — A LATE SUCCESS MUST NOT RESURRECT A FINISHED FLOW. The user may have
      // closed the drawer, or submitted (which clears the draft and lands on `done`), while the
      // parse was still running. Writing the four fields and `setStep('review')` here would
      // repopulate a cleared draft and bounce them off the confirmation screen.
      if (!isFlowActiveRef.current) return;

      setField('title', patch.title);
      setField('descriptionHtml', patch.descriptionHtml);
      setField('tagIds', patch.tagIds);
      setField('productIds', patch.productIds);
      setUnmatchedLabels({
        tags: patch.unmatchedTagLabels,
        products: patch.unmatchedProductLabels,
      });
      setLastGeneratedSnapshot({
        // ⚠ TRIMMED (fix round F15). `currentAiSnapshot` below compares against `title.trim()`,
        // so storing the raw value made a model title with any leading/trailing whitespace
        // differ from itself the instant it landed — and Regenerate then opened the
        // "you have edits, they'll be replaced" dialog for a draft nobody had touched.
        title: patch.title.trim(),
        descriptionHtml: patch.descriptionHtml,
        tagIds: patch.tagIds,
        productIds: patch.productIds,
      });
      editedFieldsFiredRef.current = new Set();

      const durationMs =
        generateStartedAtRef.current === null ? 0 : Date.now() - generateStartedAtRef.current;
      track(PROJECT_EVENTS.PROJECT_AI_GENERATE_SUCCEEDED, {
        document_count: draft.documents.length,
        is_regenerate: isRegenerateRef.current,
        tag_count: patch.tagIds.length,
        product_count: patch.productIds.length,
        unmatched_tag_count: patch.unmatchedTagLabels.length,
        unmatched_product_count: patch.unmatchedProductLabels.length,
        duration_ms: durationMs,
      });
      setStep('review');
    },
    [draft.documents.length, setField, setStep]
  );

  const briefGeneration = useProjectBriefGeneration({ onSucceeded: handleGenerationSucceeded });

  const { cancel: cancelBriefGeneration } = briefGeneration;

  /**
   * ⚠⚠ ABANDONING THE FLOW CLEARS ITS FAILURE, not just its success.
   *
   * `isFlowActive` already declares the flow abandoned the moment the drawer closes (or the
   * request is submitted), and `handleGenerationSucceeded` discards a parse that lands after
   * that point. The FAILURE phase had no matching reset, so a failed generate survived
   * close→reopen: the user reopened the drawer, re-picked the AI path, and met the banner from
   * the previous attempt — over an empty dropzone, still claiming "Your files are still
   * attached". `cancel` (not `dismissFailure`) because an abandoned flow should also stop
   * polling, not merely hide its banner.
   */
  useEffect(() => {
    if (isFlowActive) return;
    cancelBriefGeneration();
  }, [isFlowActive, cancelBriefGeneration]);

  /**
   * ⚠ The banner's copy asserts "Your files are still attached" — false once the last one is
   * removed, which is exactly what a user does to recover from a failure. Removing the final
   * document retires the failure with it; `documentCount > 0` is left alone so removing one of
   * several keeps the banner (its copy is still true, and Try again still has input).
   */
  const documentCount = draft.documents.length;
  useEffect(() => {
    if (documentCount > 0) return;
    cancelBriefGeneration();
  }, [documentCount, cancelBriefGeneration]);

  // `PROJECT_AI_GENERATE_FAILED` fires once per failure occurrence (never once per re-render).
  useEffect(() => {
    if (briefGeneration.phase === 'failed' && briefGeneration.failureReason !== null) {
      if (!failureTrackedRef.current) {
        failureTrackedRef.current = true;
        track(PROJECT_EVENTS.PROJECT_AI_GENERATE_FAILED, {
          document_count: draft.documents.length,
          is_regenerate: isRegenerateRef.current,
          failure_reason: briefGeneration.failureReason,
        });
      }
    } else {
      failureTrackedRef.current = false;
    }
  }, [briefGeneration.phase, briefGeneration.failureReason, draft.documents.length]);

  // `PROJECT_AI_FIELDS_EDITED` fires once per field-key when it first diverges from the last
  // generated snapshot (guarded by a ref so a keystroke stream fires once). ⚠ Only while the draft
  // IS the AI brief: a new hero search swaps in a fresh manual draft (`useProjectSeed`), and every
  // field "diverging" from the snapshot then is no visitor edit.
  useEffect(() => {
    if (lastGeneratedSnapshot === null || draft.source !== 'ai') return;
    const checks: Array<[string, boolean]> = [
      ['title', trimmedTitle !== lastGeneratedSnapshot.title],
      ['description', descriptionHtml !== lastGeneratedSnapshot.descriptionHtml],
      ['tags', JSON.stringify(tagIds) !== JSON.stringify(lastGeneratedSnapshot.tagIds)],
      ['products', JSON.stringify(productIds) !== JSON.stringify(lastGeneratedSnapshot.productIds)],
    ];
    for (const [field, diverged] of checks) {
      if (diverged && !editedFieldsFiredRef.current.has(field)) {
        editedFieldsFiredRef.current.add(field);
        track(PROJECT_EVENTS.PROJECT_AI_FIELDS_EDITED, {
          field: field as 'title' | 'description' | 'tags' | 'products',
        });
      }
    }
  }, [trimmedTitle, descriptionHtml, tagIds, productIds, lastGeneratedSnapshot, draft.source]);

  const handleGenerateClick = useCallback(() => {
    isRegenerateRef.current = false;
    generateStartedAtRef.current = Date.now();
    track(PROJECT_EVENTS.PROJECT_AI_GENERATE_STARTED, {
      document_count: draft.documents.length,
      is_regenerate: false,
    });
    // ⚠ `start` handles every EXPECTED failure itself and always resolves on a
    // TERMINAL phase; this `.catch` only reports a bug that let a rejection escape that handling.
    briefGeneration
      .start({ kind: 'documents', documents: draft.documents })
      .catch(reportUnexpectedBriefError);
  }, [draft.documents, briefGeneration]);

  const handleRetryGenerate = useCallback(() => {
    briefGeneration.dismissFailure();
    handleGenerateClick();
  }, [briefGeneration, handleGenerateClick]);

  // ⚠ `cancel`, NOT `dismissFailure` (BAL-254 W2). `dismissFailure` only resets the phase; it
  // leaves the interval running and `parseIdRef` set, so the generation this hook is walking away
  // from could still land and overwrite the draft the user is about to type by hand.
  const cancelGeneration = useCallback(() => {
    briefGeneration.cancel();
  }, [briefGeneration]);

  const handleWriteItMyself = useCallback(() => {
    briefGeneration.cancel();
    setField('source', 'manual');
    setStep('manual');
  }, [briefGeneration, setField, setStep]);

  const runRegenerate = useCallback(() => {
    // ⚠ Fired ONLY here — after any confirm dialog is ACCEPTED — so a cancelled confirm never
    // counts as a regenerate (design: "a trust signal about actual re-runs, not intent").
    track(PROJECT_EVENTS.PROJECT_AI_REGENERATE_CLICKED, { had_edits: hasEditsSinceGenerate });
    isRegenerateRef.current = true;
    generateStartedAtRef.current = Date.now();
    track(PROJECT_EVENTS.PROJECT_AI_GENERATE_STARTED, {
      document_count: draft.documents.length,
      is_regenerate: true,
    });
    // See `handleGenerateClick` for why this `.catch` exists at all.
    briefGeneration
      .start({ kind: 'documents', documents: draft.documents })
      .catch(reportUnexpectedBriefError);
  }, [draft.documents, briefGeneration, hasEditsSinceGenerate]);

  const handleRegenerateClick = useCallback(() => {
    if (hasEditsSinceGenerate) {
      setRegenerateConfirmOpen(true);
      return;
    }
    runRegenerate();
  }, [hasEditsSinceGenerate, runRegenerate]);

  const handleConfirmRegenerate = useCallback(() => {
    setRegenerateConfirmOpen(false);
    runRegenerate();
  }, [runRegenerate]);

  return {
    briefGeneration,
    isGenerating: briefGeneration.phase === 'generating',
    isUploadFailed: briefGeneration.phase === 'failed',
    unmatchedLabels,
    hasEditsSinceGenerate,
    regenerateConfirmOpen,
    setRegenerateConfirmOpen,
    handleSelectAi,
    cancelGeneration,
    handleGenerateClick,
    handleRetryGenerate,
    handleWriteItMyself,
    handleRegenerateClick,
    handleConfirmRegenerate,
    capturedAiState,
    clearAiState,
    restoreAiState,
  };
}
