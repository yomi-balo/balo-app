'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { track, CASE_BRIEF_EVENTS } from '@/lib/analytics';
import type { ProjectBriefFailureReason } from '@balo/shared/project-requests';
import type { ProjectBriefDraftPatch } from '@/lib/project-request/actions/get-project-brief-parse';
import { isDescriptionEmpty } from '@/components/balo/rich-text/plain-text';
import {
  useProjectBriefGeneration,
  reportUnexpectedBriefError,
  type BriefGenerationPhase,
} from './use-project-brief-generation';
import { useProgressiveReveal } from './use-progressive-reveal';
import { snapshotsDiffer, type AiFieldSnapshot } from './use-ai-brief-flow';
import {
  allDraftDocuments,
  type ProjectDraft,
  type SetProjectDraftField,
} from './use-project-draft';

/**
 * The minimal case shape this flow needs to prefill a draft and start a generation.
 * {@link ProjectRequestSourceCase} (`project-request-panel.tsx`) — which also carries the
 * case's files — satisfies this structurally, so the panel passes its `sourceCase` prop here
 * unchanged with no import cycle between the two modules.
 */
export interface CaseBriefSourceCase {
  id: string;
  title: string;
  productIds: readonly string[];
}

export interface UseCaseBriefFlowOptions {
  /** `undefined` on every non-case mount — the whole flow is then inert (see below). */
  sourceCase: CaseBriefSourceCase | undefined;
  open: boolean;
  /** False once the drawer is closed or the request has been submitted — a late success or
   *  failure must write nothing (mirrors `useAiBriefFlow`'s `isFlowActive`). */
  isFlowActive: boolean;
  draft: ProjectDraft;
  setField: SetProjectDraftField;
}

export type CaseBriefPhase = 'idle' | 'generating' | 'revealing' | 'failed';

export interface UseCaseBriefFlowResult {
  phase: CaseBriefPhase;
  failureReason: ProjectBriefFailureReason | null;
  /** The progressively-revealed HTML while `phase === 'revealing'`; `null` otherwise. */
  revealedHtml: string | null;
  /** True once at least one case brief has landed successfully — persisted, so
   *  this reads `true` again after a reload too, not only within the mount that generated it. */
  hasAiDraft: boolean;
  hasEditsSinceGenerate: boolean;
  regenerateConfirmOpen: boolean;
  setRegenerateConfirmOpen: (open: boolean) => void;
  handleRedraftClick: () => void;
  handleConfirmRedraft: () => void;
  handleRetry: () => void;
  dismissFailure: () => void;
}

/**
 * A case mount is RESUMING (not fresh) when its draft already carries a brief or any
 * document. Resuming means no prefill and no auto-generate.
 *
 * ⚠ Reads {@link allDraftDocuments}, not `draft.documents` alone, so a draft
 * that only holds a case-file selection (never an upload) is correctly treated as resuming too.
 */
function isResumingCaseDraft(
  draft: Pick<ProjectDraft, 'descriptionHtml' | 'documents' | 'caseFileSelections'>
): boolean {
  return !isDescriptionEmpty(draft.descriptionHtml) || allDraftDocuments(draft).length > 0;
}

/**
 * `willAutoStart` forces `'generating'` from the very first render, before the auto-start
 * effect has run `start()` for real.
 */
function resolveCaseBriefPhase(
  generationPhase: BriefGenerationPhase,
  revealing: boolean,
  willAutoStart: boolean
): CaseBriefPhase {
  if (generationPhase === 'generating' || willAutoStart) return 'generating';
  if (generationPhase === 'failed') return 'failed';
  if (revealing) return 'revealing';
  return 'idle';
}

/**
 * BAL-589 — the case-history sibling of `useAiBriefFlow`: drafts a brief from the bound case's
 * messages and call transcripts instead of uploaded documents, auto-starting once per open
 * rather than waiting for a user click, and revealing the finished result progressively
 * instead of landing it all at once.
 *
 * INERT by construction when `sourceCase` is `undefined` — every effect and handler below
 * no-ops on that branch, so the panel can call this hook UNCONDITIONALLY on every mount mode
 * (hooks can't be called conditionally) without a non-case mount ever starting a generation,
 * tracking an event, or touching the draft.
 */
export function useCaseBriefFlow({
  sourceCase,
  open,
  isFlowActive,
  draft,
  setField,
}: UseCaseBriefFlowOptions): UseCaseBriefFlowResult {
  const [regenerateConfirmOpen, setRegenerateConfirmOpen] = useState(false);
  const [revealRunKey, setRevealRunKey] = useState(0);
  const [revealHtml, setRevealHtml] = useState<string | null>(null);

  const isFlowActiveRef = useRef(isFlowActive);
  isFlowActiveRef.current = isFlowActive;

  const sourceCaseRef = useRef(sourceCase);
  sourceCaseRef.current = sourceCase;

  const draftRef = useRef(draft);
  draftRef.current = draft;

  const generateStartedAtRef = useRef<number | null>(null);
  const failureTrackedRef = useRef(false);
  const openAutoStartedRef = useRef(false);

  // ⚠ `hasAiDraft`/`hasEditsSinceGenerate` are DERIVED from the PERSISTED
  // `draft.caseBriefSnapshot`, not mount-scoped hook state, so a reload still knows a brief
  // landed (and still diffs edits against it) instead of resetting to "no AI draft" every time.
  const { title, descriptionHtml, tagIds, productIds, caseBriefSnapshot } = draft;
  const trimmedTitle = title.trim();
  const hasAiDraft = caseBriefSnapshot !== null;

  const currentSnapshot: AiFieldSnapshot = useMemo(
    () => ({ title: trimmedTitle, descriptionHtml, tagIds, productIds }),
    [trimmedTitle, descriptionHtml, tagIds, productIds]
  );
  const hasEditsSinceGenerate =
    caseBriefSnapshot !== null && snapshotsDiffer(caseBriefSnapshot, currentSnapshot);

  // ⚠⚠ True on a case mount that WILL auto-start a generation on THIS render,
  // computed synchronously (not from the auto-start effect below) so the very FIRST render
  // already reports `phase: 'generating'` — see the `phase` computation further down. Without
  // this, the first paint showed the plain (empty) editor for one frame before the effect's
  // `start()` call landed its own `generating` state.
  const willAutoStart =
    sourceCase !== undefined && open && !openAutoStartedRef.current && !isResumingCaseDraft(draft);

  const handleGenerationSucceeded = useCallback(
    (patch: ProjectBriefDraftPatch) => {
      if (!isFlowActiveRef.current) return;

      // Title/products keep the case prefill unless the field is empty; description and
      // tags are always written (a redraft replaces them outright).
      const current = draftRef.current;
      const nextTitle = current.title.trim() === '' ? patch.title : current.title;
      const nextProductIds =
        current.productIds.length === 0 ? patch.productIds : current.productIds;

      if (current.title.trim() === '') setField('title', patch.title);
      setField('descriptionHtml', patch.descriptionHtml);
      setField('tagIds', patch.tagIds);
      if (current.productIds.length === 0) setField('productIds', patch.productIds);

      // ⚠ Persisted, so it survives a reload (replaces local `hasAiDraft` state).
      setField('caseBriefSnapshot', {
        title: nextTitle.trim(),
        descriptionHtml: patch.descriptionHtml,
        tagIds: patch.tagIds,
        productIds: nextProductIds,
      });
      setRevealHtml(patch.descriptionHtml);
      setRevealRunKey((k) => k + 1);

      const sourceCaseNow = sourceCaseRef.current;
      if (sourceCaseNow !== undefined) {
        const latencyMs =
          generateStartedAtRef.current === null ? 0 : Date.now() - generateStartedAtRef.current;
        track(CASE_BRIEF_EVENTS.GENERATED, {
          case_id: sourceCaseNow.id,
          latency_ms: latencyMs,
          success: true,
          failure_reason: null,
        });
      }
    },
    [setField]
  );

  const briefGeneration = useProjectBriefGeneration({ onSucceeded: handleGenerationSucceeded });
  const {
    start: startGeneration,
    cancel: cancelBriefGeneration,
    dismissFailure: dismissGenerationFailure,
  } = briefGeneration;

  // Abandon on flow inactive (drawer closed / request submitted) — mirrors `useAiBriefFlow`.
  useEffect(() => {
    if (isFlowActive) return;
    cancelBriefGeneration();
  }, [isFlowActive, cancelBriefGeneration]);

  // `CASE_BRIEF_GENERATED` fires once per terminal FAILURE occurrence (the success arm fires
  // from `handleGenerationSucceeded` itself, at the moment it has the patch in hand).
  useEffect(() => {
    if (briefGeneration.phase === 'failed' && briefGeneration.failureReason !== null) {
      if (!failureTrackedRef.current) {
        failureTrackedRef.current = true;
        const sourceCaseNow = sourceCaseRef.current;
        if (sourceCaseNow !== undefined) {
          const latencyMs =
            generateStartedAtRef.current === null ? 0 : Date.now() - generateStartedAtRef.current;
          track(CASE_BRIEF_EVENTS.GENERATED, {
            case_id: sourceCaseNow.id,
            latency_ms: latencyMs,
            success: false,
            failure_reason: briefGeneration.failureReason,
          });
        }
      }
    } else {
      failureTrackedRef.current = false;
    }
  }, [briefGeneration.phase, briefGeneration.failureReason]);

  const runGenerate = useCallback(() => {
    const sourceCaseNow = sourceCaseRef.current;
    if (sourceCaseNow === undefined) return;
    generateStartedAtRef.current = Date.now();
    // ⚠ Starting a NEW run (auto-start or redraft) clears the snapshot; a run
    // that fails leaves it cleared (only a SUCCESS writes a fresh one), so `hasAiDraft` correctly
    // reads `false` for the duration of — and after a failed — every run but the first idle one.
    setField('caseBriefSnapshot', null);
    // ⚠ See `use-ai-brief-flow.ts`'s `handleGenerateClick`: `start` resolves on a
    // terminal phase for every EXPECTED failure; this `.catch` only reports a bug that escaped it.
    startGeneration({ kind: 'case', caseId: sourceCaseNow.id }).catch(reportUnexpectedBriefError);
  }, [startGeneration, setField]);

  // Auto-start exactly once per open, unless the draft is already resuming a brief.
  useEffect(() => {
    if (!open) {
      openAutoStartedRef.current = false;
      return;
    }
    if (openAutoStartedRef.current) return;
    const sourceCaseNow = sourceCaseRef.current;
    if (sourceCaseNow === undefined) return;
    openAutoStartedRef.current = true;

    if (isResumingCaseDraft(draftRef.current)) return;

    if (draftRef.current.title.trim() === '') setField('title', sourceCaseNow.title);
    if (draftRef.current.productIds.length === 0) {
      setField('productIds', [...sourceCaseNow.productIds]);
    }
    runGenerate();
    // `sourceCase`/`draft` are read through refs (fresh at the instant this effect first runs
    // for a given `open`); only `open` itself should re-trigger it.
  }, [open, runGenerate, setField]);

  const runRedraft = useCallback(() => {
    const sourceCaseNow = sourceCaseRef.current;
    if (sourceCaseNow === undefined) return;
    track(CASE_BRIEF_EVENTS.REGENERATED, { case_id: sourceCaseNow.id });
    runGenerate();
  }, [runGenerate]);

  const handleRedraftClick = useCallback(() => {
    if (hasEditsSinceGenerate) {
      setRegenerateConfirmOpen(true);
      return;
    }
    runRedraft();
  }, [hasEditsSinceGenerate, runRedraft]);

  const handleConfirmRedraft = useCallback(() => {
    setRegenerateConfirmOpen(false);
    runRedraft();
  }, [runRedraft]);

  const handleRetry = useCallback(() => {
    dismissGenerationFailure();
    runGenerate();
  }, [dismissGenerationFailure, runGenerate]);

  const reveal = useProgressiveReveal(revealHtml, revealRunKey);
  const phase = resolveCaseBriefPhase(briefGeneration.phase, reveal.revealing, willAutoStart);

  return {
    phase,
    failureReason: briefGeneration.failureReason,
    revealedHtml: phase === 'revealing' ? reveal.visibleHtml : null,
    hasAiDraft,
    hasEditsSinceGenerate,
    regenerateConfirmOpen,
    setRegenerateConfirmOpen,
    handleRedraftClick,
    handleConfirmRedraft,
    handleRetry,
    dismissFailure: dismissGenerationFailure,
  };
}
