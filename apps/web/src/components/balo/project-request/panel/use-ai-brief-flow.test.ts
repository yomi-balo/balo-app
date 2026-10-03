import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCallback, useState } from 'react';
import { renderHook, act } from '@testing-library/react';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import type { ProjectBriefDraftPatch } from '@/lib/project-request/actions/get-project-brief-parse';

vi.mock('server-only', () => ({}));

/**
 * The polling hook is stubbed so this suite can invoke `onSucceeded` DIRECTLY — that callback is
 * what `useAiBriefFlow` guards, and reaching it through a real 2s interval would make a fast,
 * deterministic test slow and flaky for no extra coverage.
 */
const captured: { onSucceeded?: (patch: ProjectBriefDraftPatch) => void } = {};
// `start` is `Promise<void>`; the real hook's `start()` resolves rather than
// rejects on every EXPECTED failure, so the mock does too by default (`.catch` on its result
// must have something to call `.catch` on).
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockDismissFailure = vi.fn();
const mockCancel = vi.fn();
vi.mock('./use-project-brief-generation', () => ({
  useProjectBriefGeneration: (options: {
    onSucceeded: (patch: ProjectBriefDraftPatch) => void;
  }) => {
    captured.onSucceeded = options.onSucceeded;
    return {
      phase: 'generating' as const,
      headingIndex: 0 as const,
      failureReason: null,
      start: mockStart,
      dismissFailure: mockDismissFailure,
      cancel: mockCancel,
    };
  },
  // No call-site in this suite asserts on this directly; an inline stub is enough to keep
  // `use-ai-brief-flow.ts`'s `.catch(reportUnexpectedBriefError)` from calling `undefined`.
  reportUnexpectedBriefError: vi.fn(),
}));

import { useAiBriefFlow } from './use-ai-brief-flow';
import type { ProjectDraft } from './use-project-draft';

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
  source: 'ai',
  seededFrom: null,
};

/** ⚠ DRAFT.documents is EMPTY, which is itself a reset trigger. Use this where the test is
 *  about something other than the empty-documents reset. */
const DRAFT_WITH_DOC: ProjectDraft = {
  ...DRAFT,
  documents: [
    {
      r2Key: 'project-documents/c/u/k',
      fileName: 'spec.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1000,
    },
  ],
};

const PATCH: ProjectBriefDraftPatch = {
  title: '  AI-drafted title  ',
  descriptionHtml: '<p>drafted</p>',
  tagIds: ['t1'],
  productIds: ['p1'],
  unmatchedTagLabels: [],
  unmatchedProductLabels: [],
};

function renderFlow(isFlowActive: boolean, draft: ProjectDraft = DRAFT) {
  const setField = vi.fn();
  const setStep = vi.fn();
  const view = renderHook(
    ({ active, currentDraft }: { active: boolean; currentDraft: ProjectDraft }) =>
      useAiBriefFlow({
        expertProfileId: undefined,
        entryPoint: 'direct',
        draft: currentDraft,
        setField,
        setStep,
        isFlowActive: active,
      }),
    { initialProps: { active: isFlowActive, currentDraft: draft } }
  );
  return { setField, setStep, view };
}

describe('useAiBriefFlow — the abandoned-flow guard (fix round F5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onSucceeded = undefined;
  });

  it('applies a successful parse while the flow is active', () => {
    const { setField, setStep } = renderFlow(true);
    act(() => captured.onSucceeded?.(PATCH));

    expect(setField).toHaveBeenCalledWith('title', PATCH.title);
    expect(setField).toHaveBeenCalledWith('descriptionHtml', PATCH.descriptionHtml);
    expect(setStep).toHaveBeenCalledWith('review');
  });

  it('⚠ writes NOTHING when the flow has been abandoned (drawer closed, or already submitted)', () => {
    // Closing the drawer does not unmount the panel, so the poll keeps running. A late success
    // would otherwise repopulate a draft the user cleared by submitting, and yank them off the
    // confirmation screen back to `review`.
    const { setField, setStep } = renderFlow(false);
    act(() => captured.onSucceeded?.(PATCH));

    expect(setField).not.toHaveBeenCalled();
    expect(setStep).not.toHaveBeenCalled();
  });
});

/**
 * ⚠⚠ THE STALE-FAILURE BUG. `isFlowActive` already declared the flow abandoned on close, and a
 * late SUCCESS was discarded — but nothing retired a FAILURE. Reported from the running app:
 * generate failed, the user removed the file, closed the drawer, reopened it, re-picked the AI
 * path, and met the previous attempt's banner over an empty dropzone — still claiming "Your
 * files are still attached".
 */
describe('useAiBriefFlow — a failed generate does not outlive its flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onSucceeded = undefined;
  });

  it('⚠ retires the generation when the flow is abandoned (drawer closed / submitted)', () => {
    const { view } = renderFlow(true, DRAFT_WITH_DOC);
    expect(mockCancel).not.toHaveBeenCalled();

    // Closing the drawer flips `isFlowActive` — the panel is NOT unmounted.
    act(() => view.rerender({ active: false, currentDraft: DRAFT_WITH_DOC }));

    expect(mockCancel).toHaveBeenCalled();
  });

  it('⚠ retires the generation when the LAST document is removed', () => {
    const { view } = renderFlow(true, DRAFT_WITH_DOC);
    expect(mockCancel).not.toHaveBeenCalled();

    // The X on the only attached file — the banner's "Your files are still attached" is now false.
    act(() => view.rerender({ active: true, currentDraft: DRAFT }));

    expect(mockCancel).toHaveBeenCalled();
  });

  it('keeps the generation while the flow is active and a document remains', () => {
    const twoDocs: ProjectDraft = {
      ...DRAFT_WITH_DOC,
      documents: [
        ...DRAFT_WITH_DOC.documents,
        {
          r2Key: 'project-documents/c/u/k2',
          fileName: 'notes.pdf',
          contentType: 'application/pdf',
          sizeBytes: 2000,
        },
      ],
    };
    const { view } = renderFlow(true, twoDocs);

    // Removing ONE of several leaves the banner's copy true and Try again with input.
    act(() => view.rerender({ active: true, currentDraft: DRAFT_WITH_DOC }));

    expect(mockCancel).not.toHaveBeenCalled();
  });
});

describe('useAiBriefFlow — the regenerate clobber-guard snapshot (fix round F15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onSucceeded = undefined;
  });

  it('⚠ a title with surrounding whitespace does not count as an edit', () => {
    // `hasEditsSinceGenerate` compares the snapshot against `draft.title.trim()`. Storing the
    // RAW model title meant a single trailing space tripped the "you have edits, they'll be
    // replaced" dialog on a draft nobody had touched.
    const setField = vi.fn();
    const { result, rerender } = renderHook(
      ({ draft }: { draft: ProjectDraft }) =>
        useAiBriefFlow({
          expertProfileId: undefined,
          entryPoint: 'direct',
          draft,
          setField,
          setStep: vi.fn(),
          isFlowActive: true,
        }),
      { initialProps: { draft: DRAFT } }
    );

    act(() => captured.onSucceeded?.(PATCH));

    // What the panel's draft holds after the patch is applied: the RAW (untrimmed) title.
    rerender({
      draft: {
        ...DRAFT,
        title: PATCH.title,
        descriptionHtml: PATCH.descriptionHtml,
        tagIds: [...PATCH.tagIds],
        productIds: [...PATCH.productIds],
      },
    });

    expect(result.current.hasEditsSinceGenerate).toBe(false);
  });
});

/**
 * ⚠ A REAL, STATE-BACKED `setField` — NOT `vi.fn()`. `handleGenerationSucceeded` calls `setField`
 * for all four AI fields in the SAME event, and the "fields edited" tracking effect (this file's
 * next describe block exists to test) compares the CURRENT draft against the snapshot on every
 * commit. A no-op mock `setField` leaves `draft` on its stale (often empty) initial value for one
 * commit after `onSucceeded` fires, which the tracking effect reads as every field having
 * "diverged" — an artifact of the mock, not of the hook, and not what the real panel (whose
 * `setField` genuinely updates `draft`) ever does. This harness closes that gap so these tests
 * observe the same sequencing the real app does.
 */
function renderConnectedFlow(initialDraft: ProjectDraft) {
  const setStep = vi.fn();
  const view = renderHook(() => {
    const [draft, setDraftState] = useState(initialDraft);
    const setField = useCallback(<K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => {
      setDraftState((prev) => ({ ...prev, [key]: value }));
    }, []);
    return {
      draft,
      setDraftState,
      flow: useAiBriefFlow({
        expertProfileId: undefined,
        entryPoint: 'direct',
        draft,
        setField,
        setStep,
        isFlowActive: true,
      }),
    };
  });
  return { view, setStep };
}

// ⚠⚠ THE STALE-STATE BUG. `lastGeneratedSnapshot` / `unmatchedLabels` / `editedFieldsFiredRef`
// used to last for the WHOLE MOUNT, gated only by `draft.source === 'ai'` at each read site — which
// covers a draft that stays manual, but not one that goes fresh and is
// then walked back to `source: 'ai'` on the SAME draft (e.g. "Change entry method" → "Upload
// docs"). `clearAiState` / `capturedAiState` / `restoreAiState` are the fix; `useProjectSeed` calls
// them at the two moments that matter (a fresh start, and its Undo) — these are the hook-level
// unit tests for what those three do in isolation.
describe('useAiBriefFlow — capturedAiState / clearAiState / restoreAiState (the stale-state fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onSucceeded = undefined;
  });

  it('capturedAiState is null before any generate', () => {
    const { view } = renderFlow(true);
    expect(view.result.current.capturedAiState).toBeNull();
  });

  it('captures the generated snapshot and unmatched labels, with no fields marked edited yet', () => {
    const { view } = renderConnectedFlow(DRAFT);

    expect(view.result.current.flow.capturedAiState).toBeNull();

    act(() => captured.onSucceeded?.(PATCH));

    expect(view.result.current.flow.capturedAiState).toEqual({
      snapshot: {
        title: PATCH.title.trim(),
        descriptionHtml: PATCH.descriptionHtml,
        tagIds: PATCH.tagIds,
        productIds: PATCH.productIds,
      },
      unmatchedLabels: { tags: [], products: [] },
      editedFields: [],
    });
  });

  it('clearAiState wipes the snapshot AND the unmatched labels together, so re-selecting AI on a fresh draft cannot re-arm either', () => {
    const { view } = renderConnectedFlow(DRAFT);

    act(() => captured.onSucceeded?.(PATCH));
    expect(view.result.current.flow.capturedAiState).not.toBeNull();

    act(() => view.result.current.flow.clearAiState());
    expect(view.result.current.flow.capturedAiState).toBeNull();
    expect(view.result.current.flow.unmatchedLabels).toEqual({ tags: [], products: [] });

    // Re-selecting AI on the now-fresh draft (title/description reset) must not read as "edits
    // since generate" — there is nothing to compare against any more.
    act(() =>
      view.result.current.setDraftState((prev) => ({
        ...prev,
        title: 'A brand new fresh title',
        source: 'ai',
      }))
    );
    expect(view.result.current.flow.hasEditsSinceGenerate).toBe(false);
  });

  it('restoreAiState brings back an EXACT prior capture, including which fields had already fired PROJECT_AI_FIELDS_EDITED', () => {
    const { view } = renderConnectedFlow(DRAFT);

    act(() => captured.onSucceeded?.(PATCH));
    // Edit the title post-generate — fires PROJECT_AI_FIELDS_EDITED once for 'title' and records it
    // into a REF (never state — it need not be reactive on its own; nothing renders from it except
    // `capturedAiState`, which the real app only ever reads on a LATER, separately-triggered render
    // — a fresh hero search). Force that same "one render later" here before reading it.
    act(() =>
      view.result.current.setDraftState((prev) => ({ ...prev, title: 'A hand-edited title' }))
    );
    act(() => view.rerender());

    const captured1 = view.result.current.flow.capturedAiState;
    if (captured1 === null) throw new Error('expected a captured state');
    expect(captured1.editedFields).toEqual(['title']);

    act(() => view.result.current.flow.clearAiState());
    expect(view.result.current.flow.capturedAiState).toBeNull();

    act(() => view.result.current.flow.restoreAiState(captured1));
    expect(view.result.current.flow.capturedAiState).toEqual(captured1);

    // The restored state's own memory of "title already fired" must survive too — editing title
    // AGAIN after a restore must not double-fire PROJECT_AI_FIELDS_EDITED for it.
    vi.mocked(track).mockClear();
    act(() =>
      view.result.current.setDraftState((prev) => ({
        ...prev,
        title: 'A hand-edited title, edited again',
      }))
    );
    expect(track).not.toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_AI_FIELDS_EDITED, {
      field: 'title',
    });
  });

  it('restoreAiState(null) behaves exactly like clearAiState', () => {
    const { view } = renderConnectedFlow(DRAFT);

    act(() => captured.onSucceeded?.(PATCH));
    expect(view.result.current.flow.capturedAiState).not.toBeNull();

    act(() => view.result.current.flow.restoreAiState(null));
    expect(view.result.current.flow.capturedAiState).toBeNull();
    expect(view.result.current.flow.unmatchedLabels).toEqual({ tags: [], products: [] });
  });
});

// BAL-582 (D2) — the context-free mount fires PROJECT_ENTRY_SELECTED too, carrying entry_point
// and no expert_id key (there is none to carry).
describe('useAiBriefFlow — BAL-582 context-free entry analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onSucceeded = undefined;
  });

  it('a context-free AI selection fires ENTRY_SELECTED with entry_point and no expert_id', () => {
    const { result } = renderHook(() =>
      useAiBriefFlow({
        expertProfileId: undefined,
        entryPoint: 'home',
        draft: DRAFT,
        setField: vi.fn(),
        setStep: vi.fn(),
        isFlowActive: true,
      })
    );

    act(() => result.current.handleSelectAi());

    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_ENTRY_SELECTED, {
      entry_point: 'home',
      method: 'ai',
    });
  });
});
