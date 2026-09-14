'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { track, PROJECT_EVENTS, type ProjectStep } from '@/lib/analytics';
import type { ProjectBriefDraftPatch } from '@/lib/project-request/actions/get-project-brief-parse';
import { useProjectBriefGeneration } from './use-project-brief-generation';
import type { ProjectDraft } from './use-project-draft';

/** The four AI-owned fields, snapshotted immediately after a successful generate. */
interface AiFieldSnapshot {
  title: string;
  descriptionHtml: string;
  tagIds: string[];
  productIds: string[];
}

function snapshotsDiffer(a: AiFieldSnapshot, b: AiFieldSnapshot): boolean {
  return (
    a.title !== b.title ||
    a.descriptionHtml !== b.descriptionHtml ||
    JSON.stringify(a.tagIds) !== JSON.stringify(b.tagIds) ||
    JSON.stringify(a.productIds) !== JSON.stringify(b.productIds)
  );
}

export interface UseAiBriefFlowOptions {
  expertProfileId: string | undefined;
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
  const [unmatchedLabels, setUnmatchedLabels] = useState<{ tags: string[]; products: string[] }>({
    tags: [],
    products: [],
  });
  const [regenerateConfirmOpen, setRegenerateConfirmOpen] = useState(false);
  const isRegenerateRef = useRef(false);
  const generateStartedAtRef = useRef<number | null>(null);
  const failureTrackedRef = useRef(false);
  const editedFieldsFiredRef = useRef<Set<string>>(new Set());

  const handleSelectAi = useCallback(() => {
    if (expertProfileId !== undefined) {
      track(PROJECT_EVENTS.PROJECT_ENTRY_SELECTED, { expert_id: expertProfileId, method: 'ai' });
    }
    setField('source', 'ai');
    setStep('upload');
  }, [expertProfileId, setField, setStep]);

  const currentAiSnapshot: AiFieldSnapshot = useMemo(
    () => ({ title: trimmedTitle, descriptionHtml, tagIds, productIds }),
    [trimmedTitle, descriptionHtml, tagIds, productIds]
  );
  const hasEditsSinceGenerate =
    lastGeneratedSnapshot !== null && snapshotsDiffer(lastGeneratedSnapshot, currentAiSnapshot);

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
  // generated snapshot (guarded by a ref so a keystroke stream fires once).
  useEffect(() => {
    if (lastGeneratedSnapshot === null) return;
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
  }, [trimmedTitle, descriptionHtml, tagIds, productIds, lastGeneratedSnapshot]);

  const handleGenerateClick = useCallback(() => {
    isRegenerateRef.current = false;
    generateStartedAtRef.current = Date.now();
    track(PROJECT_EVENTS.PROJECT_AI_GENERATE_STARTED, {
      document_count: draft.documents.length,
      is_regenerate: false,
    });
    // ⚠ NO `.catch(() => {})` (fix round F3). `start` now handles every failure internally and
    // always resolves on a TERMINAL phase. The empty catch that used to sit here could only ever
    // hide a bug, and it hid exactly one: a thrown start action left the panel spinning forever.
    briefGeneration.start(draft.documents);
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
    // No `.catch(() => {})` — see `handleGenerateClick` (fix round F3).
    briefGeneration.start(draft.documents);
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
  };
}
