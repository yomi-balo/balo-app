import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCallback, useState } from 'react';
import { renderHook, act } from '@testing-library/react';
import { track, CASE_BRIEF_EVENTS } from '@/lib/analytics';
import type { ProjectBriefDraftPatch } from '@/lib/project-request/actions/get-project-brief-parse';
import type { ProjectBriefFailureReason } from '@balo/shared/project-requests';

vi.mock('server-only', () => ({}));

/**
 * The polling hook is stubbed exactly as `use-ai-brief-flow.test.ts` stubs it — this suite
 * invokes `onSucceeded` DIRECTLY, and drives `phase`/`failureReason` through a mutable module
 * variable the mocked hook reads fresh on every render.
 */
const captured: { onSucceeded?: (patch: ProjectBriefDraftPatch) => void } = {};
const mockStart = vi.fn();
const mockDismissFailure = vi.fn();
const mockCancel = vi.fn();

let genState: {
  phase: 'idle' | 'generating' | 'failed';
  failureReason: ProjectBriefFailureReason | null;
} = { phase: 'idle', failureReason: null };

vi.mock('./use-project-brief-generation', () => ({
  useProjectBriefGeneration: (options: {
    onSucceeded: (patch: ProjectBriefDraftPatch) => void;
  }) => {
    captured.onSucceeded = options.onSucceeded;
    return {
      phase: genState.phase,
      headingIndex: 0 as const,
      failureReason: genState.failureReason,
      start: mockStart,
      dismissFailure: mockDismissFailure,
      cancel: mockCancel,
    };
  },
}));

// This flow's own progressive-reveal mechanics are `use-progressive-reveal.ts`'s own suite's
// job — stubbed here to a fixed, non-revealing value so this suite's assertions are about the
// FLOW, not the reveal animation.
vi.mock('./use-progressive-reveal', () => ({
  useProgressiveReveal: () => ({ revealing: false, visibleHtml: '' }),
}));

import { useCaseBriefFlow, type CaseBriefSourceCase } from './use-case-brief-flow';
import type { ProjectDraft } from './use-project-draft';

const SOURCE_CASE: CaseBriefSourceCase = {
  id: 'case-1',
  title: 'Skills-based routing rollout',
  productIds: ['p1', 'p2'],
};

const DRAFT: ProjectDraft = {
  routing: 'direct',
  title: '',
  descriptionHtml: '',
  tagIds: [],
  productIds: [],
  documents: [],
  budgetMinCents: null,
  budgetMaxCents: null,
  timeline: null,
  caseFileSelections: {},
  caseBriefSnapshot: null,
  source: 'manual',
  seededFrom: null,
};

const PATCH: ProjectBriefDraftPatch = {
  title: 'Drafted from case',
  descriptionHtml: '<h2>Problem</h2><p>Drafted body</p>',
  tagIds: ['t1'],
  productIds: ['p3'],
  unmatchedTagLabels: [],
  unmatchedProductLabels: [],
};

interface FlowProps {
  sourceCase: CaseBriefSourceCase | undefined;
  open: boolean;
  isFlowActive: boolean;
  draft: ProjectDraft;
}

function renderFlow(overrides: Partial<FlowProps> = {}) {
  const setField = vi.fn();
  const initialProps: FlowProps = {
    sourceCase: SOURCE_CASE,
    open: true,
    isFlowActive: true,
    draft: DRAFT,
    ...overrides,
  };
  const view = renderHook((props: FlowProps) => useCaseBriefFlow({ ...props, setField }), {
    initialProps,
  });
  return { setField, view };
}

describe('useCaseBriefFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onSucceeded = undefined;
    genState = { phase: 'idle', failureReason: null };
  });

  describe('inert when sourceCase is undefined', () => {
    it('never auto-starts, and reports idle', () => {
      const { view } = renderFlow({ sourceCase: undefined });
      expect(mockStart).not.toHaveBeenCalled();
      expect(view.result.current.phase).toBe('idle');
    });

    it('a redraft click does nothing', () => {
      const { view } = renderFlow({ sourceCase: undefined });
      act(() => view.result.current.handleRedraftClick());
      expect(mockStart).not.toHaveBeenCalled();
      expect(track).not.toHaveBeenCalled();
    });
  });

  describe('auto-start (S5)', () => {
    it('starts exactly once per open, with {kind: "case", caseId}', () => {
      const { view } = renderFlow();
      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(mockStart).toHaveBeenCalledWith({ kind: 'case', caseId: SOURCE_CASE.id });

      // Re-rendering with the SAME open=true must not re-fire.
      view.rerender({ sourceCase: SOURCE_CASE, open: true, isFlowActive: true, draft: DRAFT });
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    it('re-arms on a close→reopen (open flips false then true)', () => {
      const { view } = renderFlow();
      expect(mockStart).toHaveBeenCalledTimes(1);

      view.rerender({ sourceCase: SOURCE_CASE, open: false, isFlowActive: false, draft: DRAFT });
      view.rerender({ sourceCase: SOURCE_CASE, open: true, isFlowActive: true, draft: DRAFT });
      expect(mockStart).toHaveBeenCalledTimes(2);
    });

    it('prefills an empty title and productIds from the case before starting', () => {
      const { setField } = renderFlow();
      expect(setField).toHaveBeenCalledWith('title', SOURCE_CASE.title);
      expect(setField).toHaveBeenCalledWith('productIds', [...SOURCE_CASE.productIds]);
    });

    it('never overwrites a non-empty title or productIds', () => {
      const { setField } = renderFlow({
        draft: { ...DRAFT, title: 'Already set', productIds: ['existing'] },
      });
      expect(setField).not.toHaveBeenCalledWith('title', expect.anything());
      expect(setField).not.toHaveBeenCalledWith('productIds', expect.anything());
    });

    it('a resumed draft (non-empty description) does not auto-start or prefill', () => {
      const { setField } = renderFlow({
        draft: { ...DRAFT, descriptionHtml: '<p>Existing brief</p>' },
      });
      expect(mockStart).not.toHaveBeenCalled();
      expect(setField).not.toHaveBeenCalled();
    });

    it('a resumed draft (any document present) does not auto-start', () => {
      const { setField } = renderFlow({
        draft: {
          ...DRAFT,
          documents: [
            {
              r2Key: 'project-documents/c/u/k',
              fileName: 'case-file.pdf',
              contentType: 'application/pdf',
              sizeBytes: 100,
            },
          ],
        },
      });
      expect(mockStart).not.toHaveBeenCalled();
      expect(setField).not.toHaveBeenCalled();
    });
  });

  // ── F4 — no idle flash before auto-start ───────────────────────────────────────────────────
  describe('the idle flash before auto-start (F4)', () => {
    it('reports `generating` from the very first render of a fresh case mount', () => {
      // `useProjectBriefGeneration` is mocked to a static `genState` that never flips on its
      // own — so this can ONLY read `'generating'` if `willAutoStart` drives it, proving the
      // fix doesn't merely wait for the real hook's own (asynchronous) `start()` call.
      const { view } = renderFlow();
      expect(view.result.current.phase).toBe('generating');
      expect(view.result.current.hasAiDraft).toBe(false);
    });

    it('does not force `generating` for a draft that is already resuming', () => {
      const { view } = renderFlow({
        draft: { ...DRAFT, descriptionHtml: '<p>Existing brief</p>' },
      });
      expect(view.result.current.phase).toBe('idle');
    });

    it('does not force `generating` when sourceCase is undefined', () => {
      const { view } = renderFlow({ sourceCase: undefined });
      expect(view.result.current.phase).toBe('idle');
    });
  });

  // ── F5 — hasAiDraft/hasEditsSinceGenerate are PERSISTED, not mount-scoped ──────────────────
  describe('the persisted snapshot survives a remount (F5)', () => {
    it('hasAiDraft reads true on a FRESH mount when the draft already carries a snapshot', () => {
      const persistedDraft = {
        ...DRAFT,
        title: 'Drafted title',
        descriptionHtml: '<p>Drafted body</p>',
        caseBriefSnapshot: {
          title: 'Drafted title',
          descriptionHtml: '<p>Drafted body</p>',
          tagIds: [],
          productIds: [],
        },
      };
      // A brand-new hook instance — never calls `onSucceeded` itself — exactly what a page
      // reload looks like once `useProjectDraft` has hydrated the persisted draft.
      const { view } = renderFlow({ draft: persistedDraft });
      expect(view.result.current.hasAiDraft).toBe(true);
      expect(view.result.current.hasEditsSinceGenerate).toBe(false);
    });

    it('hasEditsSinceGenerate is true when the reloaded draft differs from its own snapshot', () => {
      const persistedDraft = {
        ...DRAFT,
        descriptionHtml: '<p>Edited after reload</p>',
        caseBriefSnapshot: {
          title: '',
          descriptionHtml: '<p>Drafted body</p>',
          tagIds: [],
          productIds: [],
        },
      };
      const { view } = renderFlow({ draft: persistedDraft });
      expect(view.result.current.hasAiDraft).toBe(true);
      expect(view.result.current.hasEditsSinceGenerate).toBe(true);
    });
  });

  describe('a successful generation', () => {
    it('always writes the description and tags', () => {
      const { setField } = renderFlow({
        draft: { ...DRAFT, title: 'My own title', productIds: ['mine'] },
      });
      act(() => captured.onSucceeded?.(PATCH));

      expect(setField).toHaveBeenCalledWith('descriptionHtml', PATCH.descriptionHtml);
      expect(setField).toHaveBeenCalledWith('tagIds', PATCH.tagIds);
      // ⚠ FIX ROUND F5 — `hasAiDraft` is now DERIVED from the persisted `caseBriefSnapshot`,
      // which this bare `vi.fn()` setField never writes back into `draft`; assert the WRITE
      // instead of the (unchanged, in this harness) derived read.
      expect(setField).toHaveBeenCalledWith(
        'caseBriefSnapshot',
        expect.objectContaining({ descriptionHtml: PATCH.descriptionHtml, tagIds: PATCH.tagIds })
      );
    });

    it('keeps a non-empty title and productIds — never overwritten by the patch', () => {
      const { setField } = renderFlow({
        draft: { ...DRAFT, title: 'My own title', productIds: ['mine'] },
      });
      setField.mockClear();
      act(() => captured.onSucceeded?.(PATCH));

      expect(setField).not.toHaveBeenCalledWith('title', expect.anything());
      expect(setField).not.toHaveBeenCalledWith('productIds', expect.anything());
    });

    it('fills an empty title/productIds from the patch when nothing claimed them first', () => {
      // Use a case with no productIds/title so the auto-start prefill leaves them empty.
      const { setField } = renderFlow({
        sourceCase: { id: 'case-2', title: '', productIds: [] },
      });
      setField.mockClear();
      act(() => captured.onSucceeded?.(PATCH));

      expect(setField).toHaveBeenCalledWith('title', PATCH.title);
      expect(setField).toHaveBeenCalledWith('productIds', PATCH.productIds);
    });

    it('tracks CASE_BRIEF_EVENTS.GENERATED with success: true', () => {
      renderFlow();
      act(() => captured.onSucceeded?.(PATCH));

      expect(track).toHaveBeenCalledWith(
        CASE_BRIEF_EVENTS.GENERATED,
        expect.objectContaining({ case_id: SOURCE_CASE.id, success: true, failure_reason: null })
      );
    });

    it('a late success after the flow is abandoned (drawer closed) writes nothing', () => {
      const { view, setField } = renderFlow();
      view.rerender({ sourceCase: SOURCE_CASE, open: true, isFlowActive: false, draft: DRAFT });
      setField.mockClear();

      act(() => captured.onSucceeded?.(PATCH));

      expect(setField).not.toHaveBeenCalled();
    });
  });

  describe('a failed generation', () => {
    it('tracks CASE_BRIEF_EVENTS.GENERATED with success: false and the reason, once', () => {
      const { view } = renderFlow();
      genState = { phase: 'failed', failureReason: 'no_case_history' };
      view.rerender({ sourceCase: SOURCE_CASE, open: true, isFlowActive: true, draft: DRAFT });

      expect(track).toHaveBeenCalledWith(
        CASE_BRIEF_EVENTS.GENERATED,
        expect.objectContaining({
          case_id: SOURCE_CASE.id,
          success: false,
          failure_reason: 'no_case_history',
        })
      );
      expect(view.result.current.phase).toBe('failed');
      expect(view.result.current.failureReason).toBe('no_case_history');

      const callCountAfterFirst = vi
        .mocked(track)
        .mock.calls.filter((call) => call[0] === CASE_BRIEF_EVENTS.GENERATED).length;

      // A re-render with the SAME failed state must not re-track.
      view.rerender({ sourceCase: SOURCE_CASE, open: true, isFlowActive: true, draft: DRAFT });
      const callCountAfterSecond = vi
        .mocked(track)
        .mock.calls.filter((call) => call[0] === CASE_BRIEF_EVENTS.GENERATED).length;
      expect(callCountAfterSecond).toBe(callCountAfterFirst);
    });
  });

  describe('redraft', () => {
    /**
     * A REAL, STATE-BACKED `setField` — not a bare `vi.fn()`. `handleGenerationSucceeded`
     * writes multiple fields in the same event, and `hasEditsSinceGenerate` compares the LIVE
     * draft against the snapshot on every commit — a no-op mock leaves the draft on its stale
     * initial value, which this hook would (correctly) read as every field having "diverged".
     * Same harness shape as `use-ai-brief-flow.test.ts`'s `renderConnectedFlow`.
     */
    function renderConnectedFlow(initialDraft: ProjectDraft) {
      const view = renderHook(() => {
        const [draft, setDraftState] = useState(initialDraft);
        const setField = useCallback(
          <K extends keyof ProjectDraft>(
            key: K,
            value: ProjectDraft[K] | ((prev: ProjectDraft[K]) => ProjectDraft[K])
          ) => {
            setDraftState((prev) => ({
              ...prev,
              [key]:
                typeof value === 'function'
                  ? (value as (prev: ProjectDraft[K]) => ProjectDraft[K])(prev[key])
                  : value,
            }));
          },
          []
        );
        return {
          draft,
          setDraftState,
          flow: useCaseBriefFlow({
            sourceCase: SOURCE_CASE,
            open: true,
            isFlowActive: true,
            draft,
            setField,
          }),
        };
      });
      return view;
    }

    it('redrafting without edits runs immediately — no confirm dialog', () => {
      const view = renderConnectedFlow({ ...DRAFT, title: 'Prefilled title', productIds: ['p1'] });
      act(() => captured.onSucceeded?.(PATCH));
      mockStart.mockClear();

      expect(view.result.current.flow.hasEditsSinceGenerate).toBe(false);
      act(() => view.result.current.flow.handleRedraftClick());

      expect(view.result.current.flow.regenerateConfirmOpen).toBe(false);
      expect(mockStart).toHaveBeenCalledWith({ kind: 'case', caseId: SOURCE_CASE.id });
      expect(track).toHaveBeenCalledWith(CASE_BRIEF_EVENTS.REGENERATED, {
        case_id: SOURCE_CASE.id,
      });
    });

    it('redrafting WITH edits asks for confirmation first', () => {
      const view = renderConnectedFlow({ ...DRAFT, title: 'Prefilled title', productIds: ['p1'] });
      act(() => captured.onSucceeded?.(PATCH));
      mockStart.mockClear();

      // Simulate an edit made in the panel after the draft landed.
      act(() =>
        view.result.current.setDraftState((prev) => ({ ...prev, descriptionHtml: '<p>Edited</p>' }))
      );
      expect(view.result.current.flow.hasEditsSinceGenerate).toBe(true);

      act(() => view.result.current.flow.handleRedraftClick());
      expect(view.result.current.flow.regenerateConfirmOpen).toBe(true);
      expect(mockStart).not.toHaveBeenCalled();

      act(() => view.result.current.flow.handleConfirmRedraft());
      expect(view.result.current.flow.regenerateConfirmOpen).toBe(false);
      expect(mockStart).toHaveBeenCalledWith({ kind: 'case', caseId: SOURCE_CASE.id });
    });

    // ── F5 — the snapshot is cleared the INSTANT a new run starts, not only on failure ────────
    it('starting a redraft clears the persisted snapshot immediately — a failed redraft then submits as manual', () => {
      const view = renderConnectedFlow({
        ...DRAFT,
        title: 'Prefilled title',
        productIds: ['p1'],
      });
      act(() => captured.onSucceeded?.(PATCH));
      expect(view.result.current.flow.hasAiDraft).toBe(true);
      expect(view.result.current.draft.caseBriefSnapshot).not.toBeNull();

      mockStart.mockClear();
      act(() => view.result.current.flow.handleRedraftClick());

      // The redraft's generation never resolves in this test (genState stays 'idle' per the
      // module mock) — exactly like a run that FAILS before landing a patch: `hasAiDraft` is
      // `false` for its whole duration, so a submit while it's outstanding (or after it fails)
      // records `source: 'manual'` downstream (`resolveSubmitSource`).
      expect(view.result.current.flow.hasAiDraft).toBe(false);
      expect(view.result.current.draft.caseBriefSnapshot).toBeNull();
    });
  });

  describe('retry and dismiss', () => {
    it('handleRetry dismisses the failure and starts a new generation', () => {
      const { view } = renderFlow();
      mockStart.mockClear();
      act(() => view.result.current.handleRetry());

      expect(mockDismissFailure).toHaveBeenCalled();
      expect(mockStart).toHaveBeenCalledWith({ kind: 'case', caseId: SOURCE_CASE.id });
    });

    it('dismissFailure delegates to the generation hook', () => {
      const { view } = renderFlow();
      act(() => view.result.current.dismissFailure());
      expect(mockDismissFailure).toHaveBeenCalled();
    });
  });
});
